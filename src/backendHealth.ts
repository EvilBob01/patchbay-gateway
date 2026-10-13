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
// Designed to grow into real health checks (MCP-level probes, required vs
// optional backends): a probe that fails calls reportDown like any other
// detector, and BackendStatus is the record a health endpoint would report.
import { logger } from './logger.js';

export type BackendState = 'up' | 'reconnecting' | 'failed';

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
}

export type BackendTransition =
  | { action: 'down'; backend: string; reason: string; recentCrashes: number }
  | { action: 'connect-failed'; backend: string; reason: string }
  | { action: 'reconnected'; backend: string; attempts: number; downMs: number }
  | { action: 'failed'; backend: string; reason: string; recentCrashes: number; windowMin: number }
  | { action: 'admin-reconnect'; backend: string; admin: string; ok: boolean; error?: string };

export interface SupervisorSettings {
  baseMs: number;
  maxMs: number;
  flapMax: number;
  flapWindowMs: number;
  maxConcurrent: number;
}

export interface SupervisorOptions extends Partial<SupervisorSettings> {
  /**
   * Connect the backend again. Resolves when it is up and its tools are loaded;
   * throws otherwise. `stillWanted` turns false once the attempt is stale (the
   * backend was reset by a reload, forgotten, or the gateway stopped): a caller
   * that had to wait for the backend's connection lock checks it before it
   * spawns anything.
   */
  reconnect: (backend: string, stillWanted: () => boolean) => Promise<void>;
  /**
   * Is the backend's connection still open? Checked after a successful
   * reconnect: a process that exited in between would otherwise be marked up
   * with its exit already missed (it happened while the backend was not up).
   */
  alive?: (backend: string) => boolean;
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

/** Settings from the environment (see docs/configuration.md, "Backend crash recovery"). */
export function settingsFromEnv(): SupervisorSettings {
  const baseMs = envInt('MCP_BACKEND_RECONNECT_BASE_MS', 1000, 50);
  return {
    baseMs,
    maxMs: Math.max(baseMs, envInt('MCP_BACKEND_RECONNECT_MAX_MS', 60_000, 50)),
    flapMax: envInt('MCP_BACKEND_FLAP_MAX', 5, 1),
    flapWindowMs: envInt('MCP_BACKEND_FLAP_WINDOW_MIN', 10, 1) * 60_000,
    maxConcurrent: envInt('MCP_BACKEND_RECONNECT_CONCURRENCY', 3, 1),
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
  timer?: unknown;
  inflight?: Promise<void>;
  /** An admin reconnect in progress; a second admin request joins it (single flight). */
  manual?: Promise<string | undefined>;
  /** Bumped on reset/forget/admin action, so a stale timer or attempt is ignored. */
  epoch: number;
}

export class BackendSupervisor {
  readonly settings: SupervisorSettings;
  private recs = new Map<string, Rec>();
  private running = 0;
  private queue: (() => void)[] = [];
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
    };
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  private rec(backend: string): Rec {
    let r = this.recs.get(backend);
    if (!r) { r = { state: 'up', since: this.now(), attempt: 0, crashes: [], epoch: 0 }; this.recs.set(backend, r); }
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
    this.cancelTimer(r);
    r.state = 'up';
    r.attempt = 0;
    r.nextRetryAt = undefined;
    r.downAt = undefined;
    r.lastUpAt = this.now();
    if (wasDown) {
      r.since = this.now();
      this.emit({ action: 'reconnected', backend, attempts, downMs }, backend);
    }
  }

  /**
   * A connected backend died. Counted as a crash for flap protection; schedules
   * a reconnect, or marks it failed. Ignored when it is already down.
   */
  reportDown(backend: string, reason: string): void {
    if (this.stopped) return;
    const r = this.rec(backend);
    if (r.state !== 'up') { r.lastError = reason; return; }
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
    this.emit({ action: 'down', backend, reason, recentCrashes: crashes }, backend);
    this.schedule(backend, r);
  }

  /** A backend could not be connected at all (startup, reload). Backs off; not a crash. */
  reportConnectFailed(backend: string, reason: string): void {
    if (this.stopped) return;
    const r = this.rec(backend);
    r.lastError = reason;
    if (r.state === 'failed') return;
    if (r.state === 'up') {
      r.state = 'reconnecting';
      r.attempt = 0;
      r.since = this.now();
      r.downAt = this.now();
      this.emit({ action: 'connect-failed', backend, reason }, backend);
    }
    this.schedule(backend, r);
  }

  private fail(backend: string, r: Rec, reason: string): void {
    this.cancelTimer(r);
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
      await this.opts.reconnect(backend, () => !gone());
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
    this.recs.delete(backend);
  }

  /** Gateway shutdown: no more timers or attempts. */
  stop(): void {
    this.stopped = true;
    for (const r of this.recs.values()) { r.epoch++; this.cancelTimer(r); }
  }
}

/** The error a tool call gets while its backend is down or failed. */
export function unavailableMessage(s: BackendStatus, windowMin: number): string {
  if (s.state === 'failed') {
    return `Backend "${s.backend}" failed after repeated crashes (${s.recentCrashes} in ${windowMin} min) and is no longer reconnected automatically (down since ${s.since}); an admin must reconnect it.`;
  }
  const next = s.nextRetryAt ? `; next try at ${s.nextRetryAt}` : '';
  return `Backend "${s.backend}" is down since ${s.since} (reconnecting, attempt ${Math.max(1, s.attempt)}${next}). Try again shortly.`;
}
