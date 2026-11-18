// Backend crash recovery: per-backend state (up / reconnecting / failed),
// automatic reconnect with exponential backoff and jitter, and flap protection.
//
// mcp-proxy.ts owns the connections; this module only decides WHEN to
// reconnect and keeps the state the admin API shows. It is told that a backend
// died (reportDown: its stdio child exited, its transport closed, an HTTP
// backend stopped answering) or could not be connected (reportConnectFailed),
// and calls back into `reconnect(name)` on a timer.
//
//   - Backoff: base × 2^(attempt−1), capped, times a jitter factor in
//     [0.5, 1], so backends that died together don't retry together.
//   - At most `maxConcurrent` reconnect attempts run at once across all
//     backends; the rest queue (no reconnect storm after a network blip).
//   - Flap protection: a backend that goes from up to down `flapMax` times
//     within `flapWindowMs` is marked failed and no longer retried. Only an
//     admin (reconnectNow, a reload) or a config change brings it back.
//     Failed connect attempts are not crashes: they only back off.
//
// Health probes: every backend that is up is probed periodically at the MCP
// level (`probe`: a ping, or tools/list where ping is not supported). A probe
// that fails or times out `probeFailures` times in a row calls reportDown like
// any other detector, so a backend that stays connected but stopped answering
// goes through the same reconnect / backoff / flap path as one that exited.
//   - First probe at interval × [0.1, 1] after the backend comes up, then
//     interval × [0.9, 1.1]: backends connected together are not probed together.
//   - At most `probeConcurrency` probes run at once across all backends.
//   - Only a backend that is up is probed; one reconnecting or failed is not.
//   - A probe of a connection that was replaced, or of a backend that was
//     forgotten, is ignored when it settles.
//
// Planned replacement: a reload that changes a backend, an admin reconnect or a
// refresh closes a working connection on purpose (beginReplace, right before
// the old one is retired). The backend is `reconnecting` with `replacing` set
// until the new connection is up with its tools loaded: readiness and calls do
// not count it as up meanwhile. It is not a crash (no flap count, no `down`
// line); a replacement that fails goes on like any failed connect (backoff).
import { logger } from './logger.js';

export type BackendState = 'up' | 'reconnecting' | 'failed';

/** Who replaces a working connection on purpose (see beginReplace). */
export type ReplaceCause = 'reload' | 'admin' | 'refresh';

const REPLACE_LABEL: Record<ReplaceCause, string> = { reload: 'config reload', admin: 'admin reconnect', refresh: 'connection refresh' };
export const replaceLabel = (by: ReplaceCause): string => REPLACE_LABEL[by] ?? by;

/** Tool-call error code for a backend that is down or failed. */
export const BACKEND_UNAVAILABLE_CODE = -32013;

export interface BackendStatus {
  backend: string;
  state: BackendState;
  /** When the backend entered this state (ISO). */
  since: string;
  /** Reconnect attempts made since it went down (0 while up). */
  attempt: number;
  /** Next automatic attempt (ISO), while reconnecting. */
  nextRetryAt?: string;
  /** Why it went down, or why the last attempt failed. Admin-only: never sent to MCP clients. */
  lastError?: string;
  /** Up-to-down transitions within the flap window. */
  recentCrashes: number;
  /** Last time it was seen up (ISO). */
  lastUpAt?: string;
  /** Set while a working connection is being replaced on purpose (reconnecting). */
  replacing?: ReplaceCause;
  /** Periodic MCP-level probe state. */
  probe: ProbeStatus;
}

export interface ProbeStatus {
  /** Probes are on for this backend (globally on, and not `"probe": false`). */
  enabled: boolean;
  /** When the last probe settled (ISO). */
  lastAt?: string;
  lastOk?: boolean;
  /** How long the last probe took. */
  lastMs?: number;
  /** Why the last probe failed. Admin-only, like lastError. */
  lastError?: string;
  /** Failed probes in a row on the current connection. */
  consecutiveFailures: number;
}

/** What noticed that a backend went down (audit `cause`). */
export type DownCause = 'exit' | 'transport' | 'call' | 'probe';

export type BackendTransition =
  | { action: 'down'; backend: string; reason: string; recentCrashes: number; cause?: DownCause }
  | { action: 'connect-failed'; backend: string; reason: string }
  | { action: 'reconnected'; backend: string; attempts: number; downMs: number }
  | { action: 'failed'; backend: string; reason: string; recentCrashes: number; windowMin: number }
  | { action: 'admin-reconnect'; backend: string; admin: string; ok: boolean; error?: string }
  | { action: 'replacing'; backend: string; by: ReplaceCause }
  | { action: 'replaced'; backend: string; by: ReplaceCause; ms: number };

export interface SupervisorSettings {
  baseMs: number;
  maxMs: number;
  flapMax: number;
  flapWindowMs: number;
  maxConcurrent: number;
  /** Time between probes of one backend; 0 turns probes off. */
  probeIntervalMs: number;
  /** How long one probe may take. */
  probeTimeoutMs: number;
  /** Failed probes in a row that report the backend down. */
  probeFailures: number;
  /** Probes in flight at once, across all backends. */
  probeConcurrency: number;
}

export interface SupervisorOptions extends Partial<SupervisorSettings> {
  /**
   * Connect the backend again. Resolves when it is up and its tools are loaded;
   * throws otherwise. `stillWanted` turns false once the attempt is stale (the
   * backend was reset by a reload, forgotten, or the gateway stopped): a caller
   * that had to wait for the backend's connection lock checks it before it
   * spawns anything. `by` is set when an admin asked for it: the connection it
   * closes may be a working one (beginReplace).
   */
  reconnect: (backend: string, stillWanted: () => boolean, by?: ReplaceCause) => Promise<void>;
  /**
   * Is the backend's connection still open? Checked after a successful
   * reconnect: a process that exited in between would otherwise be marked up
   * with its exit already missed (it happened while the backend was not up).
   */
  alive?: (backend: string) => boolean;
  /**
   * Probe the backend's current connection at the MCP level. Resolves true when
   * it answered, false when the probe was skipped (its connection lock is held
   * by a reconnect or reload, or the connection is gone); throws when it did
   * not answer. Without it, probes are off.
   */
  probe?: (backend: string, timeoutMs: number) => Promise<boolean>;
  /** Per-backend switch (`"probe": false` in mcp_server.json). Default: on. */
  probeEnabled?: (backend: string) => boolean;
  onTransition?: (t: BackendTransition, status: BackendStatus) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const envInt = (name: string, fallback: number, min: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    logger.warn(`Invalid ${name}="${raw}"; using ${fallback}.`);
    return fallback;
  }
  return Math.floor(n);
};

/** Like envInt, but keeps a fraction (probe intervals below a second, for tests). */
const envNum = (name: string, fallback: number, min: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    logger.warn(`Invalid ${name}="${raw}"; using ${fallback}.`);
    return fallback;
  }
  return n;
};

/** Settings from the environment (see docs/configuration.md, "Backend crash recovery" and "Health probes"). */
export function settingsFromEnv(): SupervisorSettings {
  const baseMs = envInt('MCP_BACKEND_RECONNECT_BASE_MS', 1000, 50);
  return {
    baseMs,
    maxMs: Math.max(baseMs, envInt('MCP_BACKEND_RECONNECT_MAX_MS', 60_000, 50)),
    flapMax: envInt('MCP_BACKEND_FLAP_MAX', 5, 1),
    flapWindowMs: envInt('MCP_BACKEND_FLAP_WINDOW_MIN', 10, 1) * 60_000,
    maxConcurrent: envInt('MCP_BACKEND_RECONNECT_CONCURRENCY', 3, 1),
    probeIntervalMs: Math.round(envNum('MCP_BACKEND_PROBE_INTERVAL_S', 30, 0) * 1000),
    probeTimeoutMs: envInt('MCP_BACKEND_PROBE_TIMEOUT_MS', 10_000, 50),
    probeFailures: envInt('MCP_BACKEND_PROBE_FAILURES', 3, 1),
    probeConcurrency: envInt('MCP_BACKEND_PROBE_CONCURRENCY', 4, 1),
  };
}

interface Rec {
  state: BackendState;
  since: number;
  attempt: number;
  nextRetryAt?: number;
  lastError?: string;
  crashes: number[];
  lastUpAt?: number;
  downAt?: number;
  /** A planned replacement in progress (beginReplace until markUp or a failure). */
  replacing?: ReplaceCause;
  timer?: unknown;
  inflight?: Promise<void>;
  /** An admin reconnect in progress; a second admin request joins it (single flight). */
  manual?: Promise<string | undefined>;
  /** Bumped on reset/forget/admin action, so a stale timer or attempt is ignored. */
  epoch: number;
  probeTimer?: unknown;
  /** Bumped whenever the connection is replaced or leaves `up`, so a stale probe is ignored. */
  probeGen: number;
  probeFails: number;
  probeLastAt?: number;
  probeLastOk?: boolean;
  probeLastMs?: number;
  probeLastError?: string;
}

export class BackendSupervisor {
  readonly settings: SupervisorSettings;
  private recs = new Map<string, Rec>();
  private running = 0;
  private queue: (() => void)[] = [];
  private probesRunning = 0;
  private probeQueue: (() => void)[] = [];
  private stopped = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly opts: SupervisorOptions) {
    const env = settingsFromEnv();
    this.settings = {
      baseMs: opts.baseMs ?? env.baseMs,
      maxMs: opts.maxMs ?? env.maxMs,
      flapMax: opts.flapMax ?? env.flapMax,
      flapWindowMs: opts.flapWindowMs ?? env.flapWindowMs,
      maxConcurrent: opts.maxConcurrent ?? env.maxConcurrent,
      probeIntervalMs: opts.probeIntervalMs ?? env.probeIntervalMs,
      probeTimeoutMs: opts.probeTimeoutMs ?? env.probeTimeoutMs,
      probeFailures: opts.probeFailures ?? env.probeFailures,
      probeConcurrency: opts.probeConcurrency ?? env.probeConcurrency,
    };
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  private rec(backend: string): Rec {
    let r = this.recs.get(backend);
    if (!r) { r = { state: 'up', since: this.now(), attempt: 0, crashes: [], epoch: 0, probeGen: 0, probeFails: 0 }; this.recs.set(backend, r); }
    return r;
  }

  /** True unless the backend is known to be down or failed. */
  isUp(backend: string): boolean {
    return (this.recs.get(backend)?.state ?? 'up') === 'up';
  }

  status(backend: string): BackendStatus | undefined {
    const r = this.recs.get(backend);
    return r ? this.toStatus(backend, r) : undefined;
  }

  list(): BackendStatus[] {
    return [...this.recs.entries()].map(([b, r]) => this.toStatus(b, r)).sort((a, b) => (a.backend < b.backend ? -1 : 1));
  }

  private toStatus(backend: string, r: Rec): BackendStatus {
    const iso = (t?: number) => (t === undefined ? undefined : new Date(t).toISOString());
    return {
      backend,
      state: r.state,
      since: iso(r.since)!,
      attempt: r.attempt,
      ...(r.state === 'reconnecting' && r.nextRetryAt !== undefined ? { nextRetryAt: iso(r.nextRetryAt) } : {}),
      ...(r.lastError ? { lastError: r.lastError } : {}),
      recentCrashes: this.recentCrashes(r),
      ...(r.lastUpAt !== undefined ? { lastUpAt: iso(r.lastUpAt) } : {}),
      ...(r.replacing ? { replacing: r.replacing } : {}),
      probe: {
        enabled: this.probesOn(backend),
        ...(r.probeLastAt !== undefined ? { lastAt: iso(r.probeLastAt) } : {}),
        ...(r.probeLastOk !== undefined ? { lastOk: r.probeLastOk } : {}),
        ...(r.probeLastMs !== undefined ? { lastMs: r.probeLastMs } : {}),
        ...(r.probeLastError ? { lastError: r.probeLastError } : {}),
        consecutiveFailures: r.probeFails,
      },
    };
  }

  private recentCrashes(r: Rec): number {
    const cutoff = this.now() - this.settings.flapWindowMs;
    r.crashes = r.crashes.filter(t => t > cutoff);
    return r.crashes.length;
  }

  private emit(t: BackendTransition, backend: string): void {
    try { this.opts.onTransition?.(t, this.status(backend)!); } catch (e: any) { logger.error(`Backend health: transition hook failed: ${e?.message || e}`); }
  }

  /** The backend is connected and its tools are loaded. */
  markUp(backend: string): void {
    const r = this.rec(backend);
    const wasDown = r.state !== 'up';
    const attempts = r.attempt;
    const downMs = r.downAt !== undefined ? this.now() - r.downAt : 0;
    const replaced = r.replacing;
    r.replacing = undefined;
    this.cancelTimer(r);
    r.state = 'up';
    r.attempt = 0;
    r.nextRetryAt = undefined;
    r.downAt = undefined;
    r.lastUpAt = this.now();
    // A new (or first) connection: probe it afresh.
    this.stopProbing(r);
    r.probeFails = 0;
    this.scheduleProbe(backend, r, true);
    if (wasDown) {
      r.since = this.now();
      if (replaced) this.emit({ action: 'replaced', backend, by: replaced, ms: downMs }, backend);
      else this.emit({ action: 'reconnected', backend, attempts, downMs }, backend);
    }
  }

  /**
   * A working connection is about to be closed on purpose and replaced (a
   * reload with a changed config, an admin reconnect, a refresh). Call it under
   * the backend's connection lock, right before the old connection is retired.
   * From `up` the backend goes to `reconnecting` (not ready, calls get the
   * backend-unavailable error) without counting a crash; markUp ends it. No
   * timer: the caller is connecting it. A backend not up is left as it is.
   */
  beginReplace(backend: string, by: ReplaceCause): void {
    const r = this.recs.get(backend);
    if (this.stopped || !r || r.state !== 'up') return;
    this.stopProbing(r);
    r.state = 'reconnecting';
    r.attempt = 0;
    r.nextRetryAt = undefined;
    r.since = this.now();
    r.downAt = this.now();
    r.replacing = by;
    this.emit({ action: 'replacing', backend, by }, backend);
  }

  /** A planned replacement failed: it carries on as a failed connect (backoff). */
  private endReplaceFailed(backend: string, r: Rec, reason: string): void {
    if (!r.replacing) return;
    r.replacing = undefined;
    r.attempt = 0;
    this.emit({ action: 'connect-failed', backend, reason }, backend);
  }

  /**
   * A connected backend died. Counted as a crash for flap protection; schedules
   * a reconnect, or marks it failed. Ignored when it is already down.
   */
  reportDown(backend: string, reason: string, cause?: DownCause): void {
    if (this.stopped) return;
    const r = this.rec(backend);
    if (r.state !== 'up') { r.lastError = reason; return; }
    this.stopProbing(r);
    r.crashes.push(this.now());
    r.lastError = reason;
    r.downAt = this.now();
    r.since = this.now();
    const crashes = this.recentCrashes(r);
    if (crashes >= this.settings.flapMax) {
      this.fail(backend, r, reason);
      return;
    }
    r.state = 'reconnecting';
    r.attempt = 0;
    this.emit({ action: 'down', backend, reason, recentCrashes: crashes, ...(cause ? { cause } : {}) }, backend);
    this.schedule(backend, r);
  }

  /** A backend could not be connected at all (startup, reload). Backs off; not a crash. */
  reportConnectFailed(backend: string, reason: string): void {
    if (this.stopped) return;
    const r = this.rec(backend);
    r.lastError = reason;
    if (r.state === 'failed') return;
    if (r.state === 'up') {
      this.stopProbing(r);
      r.state = 'reconnecting';
      r.attempt = 0;
      r.since = this.now();
      r.downAt = this.now();
      this.emit({ action: 'connect-failed', backend, reason }, backend);
    } else {
      this.endReplaceFailed(backend, r, reason);
    }
    this.schedule(backend, r);
  }

  private fail(backend: string, r: Rec, reason: string): void {
    this.cancelTimer(r);
    this.stopProbing(r);
    r.state = 'failed';
    r.nextRetryAt = undefined;
    this.emit({ action: 'failed', backend, reason, recentCrashes: r.crashes.length, windowMin: Math.round(this.settings.flapWindowMs / 60_000) }, backend);
  }

  private cancelTimer(r: Rec): void {
    if (r.timer !== undefined) { this.clearTimer(r.timer); r.timer = undefined; }
  }

  /** Delay before attempt n (1-based): base × 2^(n−1), capped, × jitter in [0.5, 1]. */
  delayFor(attempt: number): number {
    const raw = Math.min(this.settings.maxMs, this.settings.baseMs * Math.pow(2, Math.max(0, attempt - 1)));
    return Math.round(raw * (0.5 + 0.5 * this.random()));
  }

  private schedule(backend: string, r: Rec): void {
    if (this.stopped || r.state !== 'reconnecting') return;
    this.cancelTimer(r);
    const delay = this.delayFor(r.attempt + 1);
    r.nextRetryAt = this.now() + delay;
    const epoch = r.epoch;
    r.timer = this.setTimer(() => {
      r.timer = undefined;
      if (r.epoch !== epoch || r.state !== 'reconnecting' || this.recs.get(backend) !== r) return;
      this.runAttempt(backend, r, epoch, true).catch(() => { /* handled inside */ });
    }, delay);
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.settings.maxConcurrent) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.running++;
    try { return await fn(); } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  /** One attempt. Automatic attempts reschedule on failure; returns the error, if any. */
  private runAttempt(backend: string, r: Rec, epoch: number, automatic: boolean): Promise<void> {
    const attempt = this.slot(async () => {
      if (r.epoch !== epoch || this.recs.get(backend) !== r || this.stopped) return;
      r.attempt++;
      r.nextRetryAt = undefined;
      try {
        await this.opts.reconnect(backend, () => r.epoch === epoch && this.recs.get(backend) === r && !this.stopped);
        this.assertAlive(backend);
        if (r.epoch !== epoch || this.recs.get(backend) !== r) return;
        this.markUp(backend);
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (r.epoch !== epoch || this.recs.get(backend) !== r) throw e;
        r.lastError = msg;
        if (r.state === 'up') { r.state = 'reconnecting'; r.since = this.now(); r.downAt ??= this.now(); }
        this.endReplaceFailed(backend, r, msg);
        logger.warn(`Backend "${backend}": reconnect attempt ${r.attempt} failed: ${msg}`);
        if (automatic) this.schedule(backend, r);
        throw e;
      }
    });
    const tracked = attempt.finally(() => { if (r.inflight === tracked) r.inflight = undefined; });
    r.inflight = tracked;
    return tracked.catch(() => { /* surfaced through status */ });
  }

  private assertAlive(backend: string): void {
    if (this.opts.alive && !this.opts.alive(backend)) throw new Error('the backend exited right after connecting');
  }

  /** Wait for any attempt in flight for this backend. */
  async settled(backend: string): Promise<void> {
    const p = this.recs.get(backend)?.inflight;
    if (p) await p.catch(() => {});
  }

  /**
   * Stop automatic retries for a backend about to be reconnected by someone
   * else (a reload): cancels its timer, invalidates any attempt in flight, and
   * clears its crash history. Its state stays until markUp/reportConnectFailed.
   * Waits for any attempt in flight, automatic or an admin's.
   */
  async reset(backend: string): Promise<void> {
    if (!this.invalidate(backend)) return;
    await this.settled(backend);
  }

  /**
   * reset() without the wait: for a caller that holds the backend's connection
   * lock (a reload), which an attempt in flight may be waiting for. That
   * attempt sees it is no longer wanted when it gets the lock. False when the
   * backend is unknown.
   */
  invalidate(backend: string): boolean {
    const r = this.recs.get(backend);
    if (!r) return false;
    r.epoch++;
    this.cancelTimer(r);
    this.stopProbing(r);
    r.crashes = [];
    r.nextRetryAt = undefined;
    // An admin acted or the config changed: a failed backend gets a fresh start.
    if (r.state === 'failed') { r.state = 'reconnecting'; r.attempt = 0; r.since = this.now(); }
    return true;
  }

  /**
   * Admin action: reconnect now, whatever the state, and clear flap history.
   * On failure the backend goes back to automatic retries with backoff.
   * Single flight: a second request while one is in progress joins it, so two
   * clicks make one reconnect. Undefined when the backend was forgotten (a
   * reload removed it) meanwhile.
   */
  async reconnectNow(backend: string, admin: string): Promise<BackendStatus | undefined> {
    const r0 = this.rec(backend);
    let op = r0.manual;
    if (!op) {
      const started = this.runManual(backend, r0);
      op = started;
      r0.manual = started;
      started.finally(() => { if (r0.manual === started) r0.manual = undefined; }).catch(() => {});
    }
    const error = await op;
    if (this.recs.get(backend) !== r0) return undefined;
    this.emit({ action: 'admin-reconnect', backend, admin, ok: !error, ...(error ? { error } : {}) }, backend);
    return this.status(backend)!;
  }

  /**
   * One admin reconnect of record r, tracked as the backend's attempt in flight.
   * Returns the error, if any. r is taken before the first await: a backend
   * forgotten meanwhile (a reload removed it) or a stopped supervisor ends it
   * here, without recreating a record or scheduling retries.
   */
  private async runManual(backend: string, r: Rec): Promise<string | undefined> {
    const gone = () => this.recs.get(backend) !== r || this.stopped;
    await this.reset(backend);
    if (gone()) return 'the backend was removed or the gateway is stopping';
    const epoch = r.epoch;
    if (r.state === 'failed') { r.state = 'reconnecting'; r.attempt = 0; r.since = this.now(); }
    // An admin asked for it: a later reset (a reload) does not cancel it, but a
    // backend that was removed meanwhile is not connected again.
    const attempt = this.slot(async () => {
      // Queued for a slot: it may have been removed while it waited.
      if (gone()) throw new Error('the backend was removed or the gateway is stopping');
      r.attempt++;
      await this.opts.reconnect(backend, () => !gone(), 'admin');
      this.assertAlive(backend);
    });
    const tracked: Promise<void> = attempt.then(() => {}, () => {}).finally(() => { if (r.inflight === tracked) r.inflight = undefined; });
    r.inflight = tracked;
    try {
      await attempt;
      if (r.epoch === epoch && this.recs.get(backend) === r) this.markUp(backend);
      return undefined;
    } catch (e: any) {
      const error = e?.message || String(e);
      if (r.epoch === epoch && this.recs.get(backend) === r) {
        r.lastError = error;
        if (r.state === 'up') { r.state = 'reconnecting'; r.since = this.now(); r.downAt = this.now(); }
        this.endReplaceFailed(backend, r, error);
        r.attempt = 0;
        this.schedule(backend, r);
      }
      return error;
    }
  }

  /** The backend left the config: drop its state and timers. */
  forget(backend: string): void {
    const r = this.recs.get(backend);
    if (!r) return;
    r.epoch++;
    this.cancelTimer(r);
    this.stopProbing(r);
    this.recs.delete(backend);
  }

  /** Gateway shutdown: no more timers or attempts. */
  stop(): void {
    this.stopped = true;
    for (const r of this.recs.values()) { r.epoch++; this.cancelTimer(r); this.stopProbing(r); }
  }

  // --- Health probes ---------------------------------------------------------

  private probesOn(backend: string): boolean {
    if (!this.opts.probe || this.settings.probeIntervalMs <= 0) return false;
    try { return this.opts.probeEnabled?.(backend) ?? true; } catch { return true; }
  }

  /** Cancel the next probe and invalidate one in flight. */
  private stopProbing(r: Rec): void {
    r.probeGen++;
    if (r.probeTimer !== undefined) { this.clearTimer(r.probeTimer); r.probeTimer = undefined; }
  }

  private probeCurrent(backend: string, r: Rec, gen: number): boolean {
    return !this.stopped && r.probeGen === gen && r.state === 'up' && this.recs.get(backend) === r;
  }

  private scheduleProbe(backend: string, r: Rec, first: boolean): void {
    if (this.stopped || r.state !== 'up' || !this.probesOn(backend)) return;
    const interval = this.settings.probeIntervalMs;
    const delay = Math.round(interval * (first ? 0.1 + 0.9 * this.random() : 0.9 + 0.2 * this.random()));
    const gen = r.probeGen;
    r.probeTimer = this.setTimer(() => {
      r.probeTimer = undefined;
      if (!this.probeCurrent(backend, r, gen)) return;
      this.runProbe(backend, r, gen).catch(e => logger.error(`Backend "${backend}": probe bookkeeping failed: ${e?.message || e}`));
    }, delay);
  }

  private async probeSlot(fn: () => Promise<void>): Promise<void> {
    if (this.probesRunning >= this.settings.probeConcurrency) {
      await new Promise<void>(resolve => this.probeQueue.push(resolve));
    }
    this.probesRunning++;
    try { await fn(); } finally {
      this.probesRunning--;
      this.probeQueue.shift()?.();
    }
  }

  /** The probe callback's result, or a rejection once the deadline passes (it may never settle). */
  private withDeadline(p: Promise<boolean>, ms: number, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const t = this.setTimer(() => reject(new Error(`no answer within ${timeoutMs} ms`)), ms);
      p.then(v => { this.clearTimer(t); resolve(v); }, e => { this.clearTimer(t); reject(e); });
    });
  }

  private async runProbe(backend: string, r: Rec, gen: number): Promise<void> {
    await this.probeSlot(async () => {
      // Queued for a slot: it may have gone down, been replaced or forgotten.
      if (!this.probeCurrent(backend, r, gen)) return;
      const timeoutMs = this.settings.probeTimeoutMs;
      const started = this.now();
      let answered = false;
      let error: string | undefined;
      try {
        // The callback's own timeout should fire first; this deadline covers one that never settles.
        answered = await this.withDeadline(Promise.resolve().then(() => this.opts.probe!(backend, timeoutMs)), timeoutMs + 1000, timeoutMs);
      } catch (e: any) {
        error = e?.message || String(e) || 'probe failed';
      }
      if (!this.probeCurrent(backend, r, gen)) return;
      if (error === undefined && !answered) { this.scheduleProbe(backend, r, false); return; } // skipped
      r.probeLastAt = this.now();
      r.probeLastMs = this.now() - started;
      if (error === undefined) {
        r.probeLastOk = true;
        r.probeLastError = undefined;
        r.probeFails = 0;
        this.scheduleProbe(backend, r, false);
        return;
      }
      r.probeLastOk = false;
      r.probeLastError = error;
      r.probeFails++;
      if (r.probeFails >= this.settings.probeFailures) {
        this.reportDown(backend, `probe: no answer (${r.probeFails} in a row): ${error}`, 'probe');
        return;
      }
      logger.warn(`Backend "${backend}": health probe failed (${r.probeFails}/${this.settings.probeFailures}): ${error}`);
      this.scheduleProbe(backend, r, false);
    });
  }
}

/** The error a tool call gets while its backend is down or failed. */
export function unavailableMessage(s: BackendStatus, windowMin: number): string {
  if (s.replacing) {
    return `Backend "${s.backend}" is reconnecting (${replaceLabel(s.replacing)}) since ${s.since}. Try again shortly.`;
  }
  if (s.state === 'failed') {
    return `Backend "${s.backend}" failed after repeated crashes (${s.recentCrashes} in ${windowMin} min) and is no longer reconnected automatically (down since ${s.since}); an admin must reconnect it.`;
  }
  const next = s.nextRetryAt ? `; next try at ${s.nextRetryAt}` : '';
  return `Backend "${s.backend}" is down since ${s.since} (reconnecting, attempt ${Math.max(1, s.attempt)}${next}). Try again shortly.`;
}
