// Offline tests for per-identity rate limiting (src/ratelimit.ts) and the
// coalesced rate-limit audit records (src/audit.ts).
//
// Uses an injected clock, so nothing sleeps. No gateway, backends or network.
//
// Run from the fork root after a build:  node test/ratelimit.test.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// audit.ts reads its directory at import time.
const auditDir = mkdtempSync(path.join(tmpdir(), 'ratelimit-audit-'));
process.env.MCP_AUDIT_DIR = auditDir;
process.env.MCP_RATE_LIMIT_TOOL_CALL_BURST = '7';
process.env.MCP_RATE_LIMIT_HTTP_PER_MINUTE = 'not-a-number';

const R = await import('../build/ratelimit.js');
const A = await import('../build/audit.js');

let failed = 0, passed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`ok   ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
};

const alice = { kind: 'user', username: 'alice', source: 'users.json' };
const bob = { kind: 'user', username: 'bob', source: 'users.json' };
const stat = { kind: 'static', username: 'static', source: 'env' };
const anon = { kind: 'anonymous', username: 'anonymous', source: 'none' };

// --- Bucket behaviour ------------------------------------------------------
let now = 1_000_000;
const clock = () => now;
const lim = new R.RateLimiter({ burst: 3, perMinute: 60 }, clock); // 1 token/s

ok([1, 2, 3].every(() => lim.take('k').allowed), 'a full bucket allows `burst` back-to-back requests');
const denied = lim.take('k');
ok(!denied.allowed, 'request burst+1 is rejected');
ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 1000, `retryAfterMs is the time to one token (${denied.retryAfterMs}ms)`);
now += 500;
ok(!lim.take('k').allowed, 'still rejected before a whole token has refilled');
now += 600;
ok(lim.take('k').allowed, 'recovers once a token has refilled');
ok(!lim.take('k').allowed, '... and only one token was refilled');
now += 60_000;
ok([1, 2, 3].every(() => lim.take('k').allowed) && !lim.take('k').allowed, 'refill is capped at burst, not accumulated');

// --- Keys: identities never share a bucket --------------------------------
const lim2 = new R.RateLimiter({ burst: 2, perMinute: 60 }, clock);
const ka = R.rateKey(alice, '192.0.2.1'), kb = R.rateKey(bob, '192.0.2.1');
lim2.take(ka); lim2.take(ka);
ok(!lim2.take(ka).allowed, 'alice exhausted');
ok(lim2.take(kb).allowed, 'bob behind the same IP is unaffected by alice');
ok(R.rateKey(alice, '192.0.2.1') === R.rateKey(alice, '198.51.100.9'), 'a user keeps one bucket across addresses');
ok(R.rateKey(stat, 'a') === R.rateKey(stat, 'b'), 'the static credential is one bucket');
ok(R.rateKey(stat, 'x') !== R.rateKey(alice, 'x'), 'static and a user never share');
ok(R.rateKey(anon, '192.0.2.1') !== R.rateKey(anon, '192.0.2.2'), 'anonymous callers are split by fallback key');

// --- Sweep -------------------------------------------------------------------
const lim3 = new R.RateLimiter({ burst: 2, perMinute: 60 }, clock);
lim3.take('a'); lim3.take('b');
ok(lim3.size === 2, 'two buckets tracked');
now += 1_100;
lim3.take('b');
lim3.sweep();
ok(lim3.size === 1, 'sweep drops refilled-to-full buckets and keeps partial ones');

// --- Env configuration -------------------------------------------------------
ok(R.TOOL_CALL_LIMIT.burst === 7, 'MCP_RATE_LIMIT_TOOL_CALL_BURST overrides the default');
ok(R.TOOL_CALL_LIMIT.perMinute === 120, 'unset tools/call rate keeps its default');
ok(R.HTTP_LIMIT.perMinute === 300, 'an invalid env value falls back to the default');
ok(R.RATE_LIMITED_CODE === -32011, 'error code is -32011');

// --- Error payload -----------------------------------------------------------
const data = R.rateLimitErrorData('tools/call', { allowed: false, retryAfterMs: 1, remaining: 0 }, R.TOOL_CALL_LIMIT);
ok(data.retryAfterSeconds === 1, 'retryAfterSeconds rounds up and is never 0');
ok(/static:static.*Retry after 1s/.test(R.rateLimitMessage(stat, data)), 'message names the caller and the retry delay');

// --- Audit coalescing --------------------------------------------------------
const entry = (who, key) => ({
  identity: who, sessionId: 's1', scope: 'tools/call', key, tool: 'h__run-command',
  errorCode: -32011, retryAfterMs: 500, burst: 7, perMinute: 120,
});
const t0 = 5_000_000;
for (let i = 0; i < 50; i++) A.recordRateLimit(entry(alice, 'user:alice'), t0 + i);   // 1 written, 49 suppressed
A.recordRateLimit(entry(bob, 'user:bob'), t0 + 60);                                  // separate caller, written
A.flushRateLimitAudit(t0 + 5_000);                                                   // too early, nothing
A.flushRateLimitAudit(t0 + 10_001);                                                  // alice tail: suppressed 49
A.flushRateLimitAudit(t0 + 20_002);                                                  // nothing pending -> state cleared
A.recordRateLimit(entry(alice, 'user:alice'), t0 + 20_003);                          // fresh hit, suppressed 0
A.recordRateLimit(entry(bob, 'user:bob'), t0 + 20_004);                              // bob: fresh hit
A.recordRateLimit(entry(bob, 'user:bob'), t0 + 20_005);                              // bob: suppressed 1
A.flushRateLimitAudit(Number.POSITIVE_INFINITY);                                     // shutdown: write it now

await A.auditDrained(); // the shutdown path's wait, used here to let the write chain finish
const lines = readdirSync(auditDir)
  .flatMap(f => readFileSync(path.join(auditDir, f), 'utf8').split('\n'))
  .filter(Boolean).map(l => JSON.parse(l));
const aliceLines = lines.filter(l => l.user === 'alice');
ok(lines.every(l => l.event === 'rate-limit' && l.ok === false && l.errorCode === -32011), 'records are rate-limit events with the error code');
ok(aliceLines.length === 3, `50+1 alice rejections produced 3 lines, not 51 (got ${aliceLines.length})`);
ok(aliceLines[0].suppressed === 0 && aliceLines[1].suppressed === 49 && aliceLines[2].suppressed === 0,
  'first hit written at once, tail carries the suppressed count, a later hit starts fresh');
const bobLines = lines.filter(l => l.user === 'bob');
ok(bobLines.length === 3 && bobLines[0].suppressed === 0, 'a second identity is recorded independently');
ok(bobLines[2].suppressed === 1, 'a shutdown flush writes a pending tail before its interval is up');
ok(aliceLines[0].tool === 'h__run-command' && aliceLines[0].limit.burst === 7, 'record carries tool and limit');
ok(!JSON.stringify(lines).includes('token'), 'no credential material in records');

rmSync(auditDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
