// Per-identity rate limiting for the MCP endpoints.
//
// Until this existed only /admin/login was throttled (per IP, in sse.ts). The
// MCP endpoints were unlimited, so one runaway agent loop could hammer every
// backend behind the gateway.
//
// Keyed by resolved caller identity, not by IP: many callers share a NAT or a
// tailnet exit, and it is the identity that a runaway agent loop belongs to.
// Callers with no attributable identity (auth disabled, or unresolvable) fall
// back to a caller-supplied key -- the client IP, or the session.
//
// Two independent limiters, both token buckets:
//   tools/call  -- the path that actually reaches backends. Checked before
//                  authorization and forwarding, so a throttled call costs the
//                  backends nothing.
//   http        -- every authenticated request on /mcp, /sse and /message,
//                  looser. Catches loops that never call a tool but spam
//                  initialize (each one builds a server instance) or tools/list.
//
// Hand-rolled and in-memory, like the login throttle: no dependency, and the
// state has the same lifetime as the sessions it protects (one process).
//
// Defaults were sized from ~94 days of journal history on both gateways
// (2026-07..10). Busiest real tools/call traffic for the whole gateway: 24 in
// 10s and 50 in a minute; HTTP: 54 in 10s and 75 in a minute. A burst of 60
// plus 120/min refill absorbs the worst observed 10s more than twice over and
// sustains ~2.4x the busiest minute even from an empty bucket; replaying the
// full history through these defaults trips nothing. A runaway loop is held to
// 2 tool calls per second.
import type { CallerIdentity } from './identity.js';

/** JSON-RPC error code for a throttled request. Next to trifecta's -32010. */
export const RATE_LIMITED_CODE = -32011;

export type RateLimitScope = 'tools/call' | 'http';

export interface BucketSettings {
  /** Bucket capacity: how many requests may arrive back-to-back. */
  burst: number;
  /** Sustained refill rate. */
  perMinute: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Milliseconds until one token is available again. 0 when allowed. */
  retryAfterMs: number;
  /** Whole tokens left after this request. */
  remaining: number;
}

interface Bucket { tokens: number; updated: number }

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const RATE_LIMIT_ENABLED = process.env.MCP_RATE_LIMIT_DISABLE !== 'true';

export const TOOL_CALL_LIMIT: Readonly<BucketSettings> = Object.freeze({
  burst: positive(process.env.MCP_RATE_LIMIT_TOOL_CALL_BURST, 60),
  perMinute: positive(process.env.MCP_RATE_LIMIT_TOOL_CALL_PER_MINUTE, 120),
});

export const HTTP_LIMIT: Readonly<BucketSettings> = Object.freeze({
  burst: positive(process.env.MCP_RATE_LIMIT_HTTP_BURST, 120),
  perMinute: positive(process.env.MCP_RATE_LIMIT_HTTP_PER_MINUTE, 300),
});

/**
 * Keyed token buckets. A bucket starts full, loses one token per request and
 * refills continuously at perMinute/60 tokens per second up to `burst`.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;

  constructor(readonly settings: BucketSettings, private readonly now: () => number = Date.now) {
    this.refillPerMs = settings.perMinute / 60_000;
  }

  take(key: string): RateDecision {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.settings.burst, updated: t };
    b.tokens = Math.min(this.settings.burst, b.tokens + (t - b.updated) * this.refillPerMs);
    b.updated = t;
    this.buckets.set(key, b);

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(b.tokens) };
    }
    return { allowed: false, retryAfterMs: Math.ceil((1 - b.tokens) / this.refillPerMs), remaining: 0 };
  }

  /** Drop buckets that have refilled to full -- they hold no state worth keeping. */
  sweep(): void {
    const t = this.now();
    for (const [key, b] of this.buckets) {
      if (b.tokens + (t - b.updated) * this.refillPerMs >= this.settings.burst) this.buckets.delete(key);
    }
  }

  get size(): number { return this.buckets.size; }
}

/**
 * Bucket key for a caller. Users and the static env credential are attributable
 * and get one bucket each, however many sessions or addresses they use.
 * Anonymous/unknown callers are not one person, so they are split by
 * `fallback` (client IP at the HTTP layer, session id at the tools/call layer)
 * rather than all sharing a single bucket.
 */
export function rateKey(identity: CallerIdentity, fallback: string | undefined): string {
  if (identity.kind === 'user' || identity.kind === 'static') return `${identity.kind}:${identity.username}`;
  return `${identity.kind}@${fallback ?? 'none'}`;
}

export interface RateLimitErrorData {
  scope: RateLimitScope;
  retryAfterSeconds: number;
  retryAfterMs: number;
  burst: number;
  perMinute: number;
}

export function rateLimitErrorData(scope: RateLimitScope, d: RateDecision, s: BucketSettings): RateLimitErrorData {
  return {
    scope,
    retryAfterSeconds: Math.max(1, Math.ceil(d.retryAfterMs / 1000)),
    retryAfterMs: d.retryAfterMs,
    burst: s.burst,
    perMinute: s.perMinute,
  };
}

export function rateLimitMessage(identity: CallerIdentity, data: RateLimitErrorData): string {
  return `Rate limit exceeded for ${identity.kind}:${identity.username} on ${data.scope} ` +
    `(${data.perMinute}/min, burst ${data.burst}). Retry after ${data.retryAfterSeconds}s.`;
}

export const toolCallLimiter = new RateLimiter(TOOL_CALL_LIMIT);
export const httpLimiter = new RateLimiter(HTTP_LIMIT);

export function rateLimitConfigSummary(): string {
  if (!RATE_LIMIT_ENABLED) return 'MCP rate limit: DISABLED (MCP_RATE_LIMIT_DISABLE=true)';
  return `MCP rate limit per identity: tools/call ${TOOL_CALL_LIMIT.perMinute}/min burst ${TOOL_CALL_LIMIT.burst}; ` +
    `http ${HTTP_LIMIT.perMinute}/min burst ${HTTP_LIMIT.burst}`;
}
