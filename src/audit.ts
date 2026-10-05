// Append-only tools/call audit trail (plus `event: 'rate-limit'` lines for
// throttled requests, see recordRateLimit).
//
// Deliberately NOT part of logger.ts. That is a 65-line console wrapper whose
// output goes to the journal and is shaped for humans reading a tail; this has
// different requirements -- a stable machine-readable schema, its own file
// outside the repo, retention, and the property that a write failure can never
// surface in a tool call. Overloading the console logger would compromise both.
//
// Format: JSON Lines, one object per tools/call, appended never rewritten.
// Location: $MCP_AUDIT_DIR (default /var/log/patchbay-gateway/audit; an existing
// pre-rename /var/log/mcp-gateway-audit is still used when unset), consistent with
// where the gateway drift check writes.
//
// Arguments are NOT recorded unless MCP_AUDIT_LOG_ARGUMENTS=true is set
// explicitly. Tool arguments on this gateway carry shell command lines, file
// paths, mailbox contents and, on a bad day, credentials. Tokens and anything
// from ALLOWED_* are never recorded at all, opt-in or not.
import { appendFile, mkdir, readdir, stat, unlink, rename } from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';
import { pathDefault } from './paths.js';
import type { CallerIdentity } from './identity.js';
import type { AuthzDecision } from './policy.js';
import type { RateLimitScope } from './ratelimit.js';

const AUDIT_DIR = pathDefault('MCP_AUDIT_DIR', '/var/log/patchbay-gateway/audit', '/var/log/mcp-gateway-audit');
const ENABLED = process.env.MCP_AUDIT_DISABLE !== 'true';
// Off by default; see the note above before turning this on.
const LOG_ARGUMENTS = process.env.MCP_AUDIT_LOG_ARGUMENTS === 'true';
const MAX_FILE_BYTES = (Number(process.env.MCP_AUDIT_MAX_FILE_MB) || 64) * 1024 * 1024;
const RETENTION_DAYS = Number(process.env.MCP_AUDIT_RETENTION_DAYS) || 14;

export interface ToolCallAuditEntry {
  /** Identity resolved from the calling session. Never undefined. */
  identity: CallerIdentity;
  /** MCP transport session id the call arrived on, if resolvable. */
  sessionId?: string;
  /** Tool name as the client asked for it (post-override exposed name). */
  tool: string;
  /** Internal qualified key (server + separator + tool), when resolved. */
  toolKey?: string;
  /** Backend server the call routed to, when resolved. */
  backend?: string;
  ok: boolean;
  durationMs: number;
  errorCode?: number | string;
  errorMessage?: string;
  /**
   * Authorization outcome, once the call resolved to a tool. A denied call is
   * recorded like any other, with decision 'deny' and the rule that decided,
   * so access decisions are attributable to an identity.
   */
  authz?: AuthzDecision;
  /** Only populated when MCP_AUDIT_LOG_ARGUMENTS=true. */
  arguments?: unknown;
  /**
   * Set when the call would have completed the lethal trifecta: blocked, let
   * through by an allow rule (with its reason), or let through in monitor mode.
   */
  trifecta?: unknown;
}

function currentFile(): string {
  // One file per UTC day. Date-stamped files are the primary rotation; the size
  // cap below only exists to stop a single runaway day from filling the disk.
  const day = new Date().toISOString().slice(0, 10);
  return path.join(AUDIT_DIR, `tools-call-${day}.jsonl`);
}

let dirReady: Promise<boolean> | null = null;
function ensureDir(): Promise<boolean> {
  if (!dirReady) {
    dirReady = mkdir(AUDIT_DIR, { recursive: true }).then(() => true).catch((e: any) => {
      // A gateway that cannot write its audit trail must still serve tool calls.
      // Warn once, loudly, and degrade -- do not retry per request.
      logger.error(`Audit log disabled: cannot create ${AUDIT_DIR}: ${e?.message || e}`);
      return false;
    });
  }
  return dirReady;
}

// Writes are serialised through this chain so concurrent tool calls cannot
// interleave partial lines, and so a slow disk cannot reorder entries.
let writeChain: Promise<void> = Promise.resolve();

async function rollIfOversized(file: string): Promise<void> {
  try {
    const { size } = await stat(file);
    if (size < MAX_FILE_BYTES) return;
    // tools-call-2026-10-02.jsonl -> tools-call-2026-10-02.jsonl.<epoch>
    await rename(file, `${file}.${Date.now()}`);
  } catch { /* missing file is the normal first-write case */ }
}

async function pruneOldFiles(): Promise<void> {
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  try {
    for (const name of await readdir(AUDIT_DIR)) {
      if (!name.startsWith('tools-call-')) continue;
      const full = path.join(AUDIT_DIR, name);
      const { mtimeMs } = await stat(full);
      if (mtimeMs < cutoff) await unlink(full);
    }
  } catch { /* best effort */ }
}

let lastPrune = 0;

/**
 * Record one tools/call. Fire-and-forget: never awaited by the request path and
 * never throws into it.
 */
export function recordToolCall(entry: ToolCallAuditEntry): void {
  if (!ENABLED) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event: 'tools/call',
    // Flattened so the common case (`who called what`) is greppable without jq.
    user: entry.identity.username,
    identityKind: entry.identity.kind,
    identitySource: entry.identity.source,
    ...(entry.identity.tier ? { tier: entry.identity.tier } : {}),
    sessionId: entry.sessionId ?? null,
    tool: entry.tool,
    toolKey: entry.toolKey ?? null,
    backend: entry.backend ?? null,
    ok: entry.ok,
    ...(entry.authz ? { decision: entry.authz.allowed ? 'allow' : 'deny', authzRule: entry.authz.rule, authzReason: entry.authz.reason } : {}),
    durationMs: entry.durationMs,
    ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
    ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
    ...(entry.trifecta ? { trifecta: entry.trifecta } : {}),
    ...(LOG_ARGUMENTS ? { arguments: entry.arguments ?? null } : {}),
  }) + '\n';

  appendLine(line);
}

function appendLine(line: string): void {
  writeChain = writeChain.then(async () => {
    if (!(await ensureDir())) return;
    const file = currentFile();
    await rollIfOversized(file);
    await appendFile(file, line, { mode: 0o600 });
    if (Date.now() - lastPrune > 3600_000) {
      lastPrune = Date.now();
      await pruneOldFiles();
    }
  }).catch((e: any) => {
    logger.error(`Audit log write failed: ${e?.message || e}`);
  });
}

export interface RateLimitAuditEntry {
  identity: CallerIdentity;
  sessionId?: string;
  scope: RateLimitScope;
  /** Bucket key the request was charged to. */
  key: string;
  /** tools/call scope: the tool asked for. */
  tool?: string;
  /** http scope: request method and path. */
  method?: string;
  path?: string;
  errorCode: number;
  retryAfterMs: number;
  burst: number;
  perMinute: number;
}

// A throttled loop can be rejected thousands of times a second; writing every
// rejection would turn the rate limiter into a way to fill the audit disk. The
// first rejection per (scope, bucket) is written immediately; after that at
// most one line per interval, carrying `suppressed` = how many rejections
// since the previous rate-limit line were not written individually.
const RATE_LIMIT_AUDIT_INTERVAL_MS = 10_000;
const rateLimitAudit = new Map<string, { lastWritten: number; suppressed: number; last: RateLimitAuditEntry }>();

function writeRateLimitLine(entry: RateLimitAuditEntry, suppressed: number): void {
  appendLine(JSON.stringify({
    ts: new Date().toISOString(),
    event: 'rate-limit',
    user: entry.identity.username,
    identityKind: entry.identity.kind,
    identitySource: entry.identity.source,
    ...(entry.identity.tier ? { tier: entry.identity.tier } : {}),
    sessionId: entry.sessionId ?? null,
    scope: entry.scope,
    ...(entry.tool ? { tool: entry.tool } : {}),
    ...(entry.method ? { method: entry.method, path: entry.path } : {}),
    ok: false,
    errorCode: entry.errorCode,
    retryAfterMs: entry.retryAfterMs,
    limit: { burst: entry.burst, perMinute: entry.perMinute },
    suppressed,
  }) + '\n');
}

/** Record a throttled request (coalesced, see above). Never throws. */
export function recordRateLimit(entry: RateLimitAuditEntry, now: number = Date.now()): void {
  if (!ENABLED) return;
  const id = `${entry.scope}|${entry.key}`;
  const state = rateLimitAudit.get(id);
  if (state && now - state.lastWritten < RATE_LIMIT_AUDIT_INTERVAL_MS) {
    state.suppressed++;
    state.last = entry;
    return;
  }
  writeRateLimitLine(entry, state?.suppressed ?? 0);
  rateLimitAudit.set(id, { lastWritten: now, suppressed: 0, last: entry });
}

/**
 * Write out suppressed counts whose interval has passed, so the tail of a burst
 * is recorded even if no further request arrives. Call periodically.
 */
export function flushRateLimitAudit(now: number = Date.now()): void {
  for (const [id, state] of rateLimitAudit) {
    if (now - state.lastWritten < RATE_LIMIT_AUDIT_INTERVAL_MS) continue;
    if (state.suppressed > 0) {
      writeRateLimitLine(state.last, state.suppressed);
      state.suppressed = 0;
      state.lastWritten = now;
    } else {
      rateLimitAudit.delete(id);
    }
  }
}

/**
 * Resolves once every queued audit line has been written (or `timeoutMs` has
 * passed -- a stuck disk must not hold up shutdown). For the shutdown path.
 */
export function auditDrained(timeoutMs = 2000): Promise<void> {
  return Promise.race([
    writeChain,
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

export function auditConfigSummary(): string {
  if (!ENABLED) return 'tools/call audit: DISABLED (MCP_AUDIT_DISABLE=true)';
  return `tools/call audit -> ${AUDIT_DIR} (arguments: ${LOG_ARGUMENTS ? 'RECORDED (opt-in)' : 'not recorded'}, retention: ${RETENTION_DAYS}d, max ${MAX_FILE_BYTES / 1048576}MB/file)`;
}
