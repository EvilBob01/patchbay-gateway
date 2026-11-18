// BackendSupervisor's periodic MCP-level probes (backendHealth.ts) on a fake
// clock: scheduling and jitter, the consecutive-failure threshold, reportDown
// through the normal reconnect/flap path, no probes while a backend is down,
// the probe concurrency cap, the probe's own timeout, and that forgotten or
// replaced backends stop being probed. The gateway wiring is in
// health-probes-gateway.test.mjs.
//
// Run from the fork root after a build:  node --test test/health-probes.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendSupervisor } from '../build/backendHealth.js';

const INTERVAL = 30_000;
const TIMEOUT = 10_000;

/**
 * A supervisor on a fake clock. Probes and reconnects are settled by hand:
 * `probes` and `reconnects` hold { backend, resolve, reject }.
 */
function harness(opts = {}) {
  let now = 1_000_000;
  const timers = [];
  const probes = [];
  const reconnects = [];
  const events = [];
  const sup = new BackendSupervisor({
    baseMs: 1000, maxMs: 60_000, flapMax: 3, flapWindowMs: 10 * 60_000, maxConcurrent: 10,
    probeIntervalMs: INTERVAL, probeTimeoutMs: TIMEOUT, probeFailures: 3, probeConcurrency: 10,
    random: () => 1,
    ...opts,
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
    reconnect: (backend) => new Promise((resolve, reject) => reconnects.push({ backend, resolve, reject })),
    probe: opts.probe ?? ((backend, timeoutMs) => new Promise((resolve, reject) => probes.push({ backend, timeoutMs, resolve, reject }))),
    onTransition: (t) => events.push(t),
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  const h = {
    sup, timers, probes, reconnects, events, flush,
    get now() { return now; },
    advance: async (ms) => {
      const end = now + ms;
      for (;;) {
        const due = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        timers.splice(timers.indexOf(due), 1);
        due.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    probeOk: async () => { probes.shift().resolve(true); await flush(); },
    probeSkip: async () => { probes.shift().resolve(false); await flush(); },
    probeFail: async (msg = 'no answer') => { probes.shift().reject(new Error(msg)); await flush(); },
  };
  return h;
}

test('probes are off without a probe callback, or with a zero interval', async () => {
  const off = new BackendSupervisor({ reconnect: async () => {}, probeIntervalMs: INTERVAL, setTimer: () => assert.fail('no timer expected') });
  off.markUp('a');
  assert.equal(off.status('a').probe.enabled, false);

  const zero = harness({ probeIntervalMs: 0 });
  zero.sup.markUp('a');
  assert.equal(zero.timers.length, 0);
  assert.equal(zero.sup.status('a').probe.enabled, false);
});

test('the first probe is at a jittered offset within the interval, later ones about one interval apart', async () => {
  const early = harness({ random: () => 0 });
  early.sup.markUp('a');
  assert.equal(early.timers.length, 1);
  assert.equal(early.timers[0].ms, INTERVAL * 0.1, 'first probe: interval x [0.1, 1]');

  const h = harness({ random: () => 1 });
  h.sup.markUp('a');
  assert.equal(h.timers[0].ms, INTERVAL);
  await h.advance(INTERVAL - 1);
  assert.equal(h.probes.length, 0, 'not before its time');
  await h.advance(1);
  assert.equal(h.probes.length, 1);
  assert.equal(h.probes[0].timeoutMs, TIMEOUT);
  await h.probeOk();
  const next = h.timers.find(t => t.ms !== TIMEOUT + 1000);
  assert.equal(next.ms, INTERVAL * 1.1, 'later probes: interval x [0.9, 1.1]');
});

test('a successful probe is recorded in the status', async () => {
  const h = harness();
  h.sup.markUp('a');
  await h.advance(INTERVAL);
  await h.advance(250);
  await h.probeOk();
  const p = h.sup.status('a').probe;
  assert.equal(p.enabled, true);
  assert.equal(p.lastOk, true);
  assert.equal(p.consecutiveFailures, 0);
  assert.equal(p.lastMs, 250);
  assert.equal(p.lastAt, new Date(h.now).toISOString());
  assert.equal(p.lastError, undefined);
});

test('failures below the threshold are counted, a success resets the count', async () => {
  const h = harness();
  h.sup.markUp('a');
  for (let i = 1; i <= 2; i++) {
    await h.advance(INTERVAL * 1.1);
    await h.probeFail('timed out');
    assert.equal(h.sup.status('a').probe.consecutiveFailures, i);
    assert.equal(h.sup.status('a').probe.lastOk, false);
    assert.equal(h.sup.status('a').probe.lastError, 'timed out');
    assert.equal(h.sup.status('a').state, 'up');
  }
  await h.advance(INTERVAL * 1.1);
  await h.probeOk();
  assert.equal(h.sup.status('a').probe.consecutiveFailures, 0);
  assert.equal(h.events.length, 0, 'no transition below the threshold');
});

test('N consecutive failures report the backend down through the normal path, with cause "probe"', async () => {
  const h = harness();
  h.sup.markUp('a');
  for (let i = 0; i < 3; i++) { await h.advance(INTERVAL * 1.1); await h.probeFail('Request timed out'); }
  const s = h.sup.status('a');
  assert.equal(s.state, 'reconnecting');
  assert.match(s.lastError, /^probe: no answer \(3 in a row\): Request timed out$/);
  assert.equal(s.recentCrashes, 1, 'a probe-triggered down counts as a crash');
  assert.deepEqual(h.events, [{ action: 'down', backend: 'a', reason: s.lastError, recentCrashes: 1, cause: 'probe' }]);

  // While it is down: no probes, only the reconnect timer.
  await h.advance(5 * INTERVAL);
  assert.equal(h.probes.length, 0, 'never probed while reconnecting');
  assert.equal(h.reconnects.length, 1);

  // Reconnected: probing resumes with a fresh count.
  h.reconnects.shift().resolve();
  await h.flush();
  assert.equal(h.sup.status('a').state, 'up');
  assert.equal(h.sup.status('a').probe.consecutiveFailures, 0);
  await h.advance(INTERVAL);
  assert.equal(h.probes.length, 1);
});

test('probe-triggered downs feed flap protection; a failed backend is never probed', async () => {
  const h = harness({ flapMax: 2 });
  const hangOnce = async () => {
    for (let i = 0; i < 3; i++) { await h.advance(INTERVAL * 1.1); await h.probeFail(); }
  };
  h.sup.markUp('a');
  await hangOnce();
  assert.equal(h.sup.status('a').state, 'reconnecting');
  await h.advance(1000);
  h.reconnects.shift().resolve();
  await h.flush();
  assert.equal(h.sup.status('a').state, 'up');
  await hangOnce();
  assert.equal(h.sup.status('a').state, 'failed');
  await h.advance(10 * INTERVAL);
  assert.equal(h.probes.length, 0);
  assert.equal(h.reconnects.length, 0);
});

test('a skipped probe (lock busy, connection gone) is not a failure and is rescheduled', async () => {
  const h = harness();
  h.sup.markUp('a');
  await h.advance(INTERVAL);
  await h.probeSkip();
  assert.equal(h.sup.status('a').probe.consecutiveFailures, 0);
  assert.equal(h.sup.status('a').probe.lastAt, undefined, 'a skip is not a probe');
  await h.advance(INTERVAL * 1.1);
  assert.equal(h.probes.length, 1);
});

test('a probe that never settles fails by the supervisor\'s own deadline', async () => {
  const h = harness();
  h.sup.markUp('a');
  await h.advance(INTERVAL);
  assert.equal(h.probes.length, 1);
  await h.advance(TIMEOUT + 1000);
  const p = h.sup.status('a').probe;
  assert.equal(p.consecutiveFailures, 1);
  assert.match(p.lastError, /no answer within 10000 ms/);
  // The late answer is ignored.
  await h.probeOk();
  assert.equal(h.sup.status('a').probe.consecutiveFailures, 1);
});

test('at most probeConcurrency probes run at once', async () => {
  const h = harness({ probeConcurrency: 2 });
  for (const b of ['a', 'b', 'c', 'd', 'e']) h.sup.markUp(b);
  await h.advance(INTERVAL);
  assert.equal(h.probes.length, 2);
  await h.probeOk();
  assert.equal(h.probes.length, 2, 'the next queued probe takes the free slot');
  await h.probeOk(); await h.probeOk(); await h.probeOk(); await h.probeOk();
  assert.equal(h.probes.length, 0);
});

test('a backend that is down is not probed even if a probe was already queued', async () => {
  const h = harness({ probeConcurrency: 1 });
  h.sup.markUp('a');
  h.sup.markUp('b');
  await h.advance(INTERVAL);
  assert.equal(h.probes.length, 1); // a; b is queued for the slot
  h.sup.reportDown('b', 'stdio process exited');
  await h.probeOk();
  assert.equal(h.probes.length, 0, 'b went down while queued: not probed');
});

test('a forgotten backend stops being probed and its record is not recreated', async () => {
  const h = harness();
  h.sup.markUp('a');
  await h.advance(INTERVAL);
  assert.equal(h.probes.length, 1);
  h.sup.forget('a');
  assert.equal(h.timers.filter(t => t.ms !== TIMEOUT + 1000).length, 0, 'no probe timer left');
  await h.probeFail();
  assert.equal(h.sup.status('a'), undefined, 'a failure arriving after forget recreates nothing');
  await h.advance(10 * INTERVAL);
  assert.equal(h.probes.length, 0);
  assert.equal(h.events.length, 0);
});

test('a probe of a replaced connection does not count against the new one', async () => {
  const h = harness({ probeFailures: 1 });
  h.sup.markUp('a');
  await h.advance(INTERVAL);
  assert.equal(h.probes.length, 1);
  h.sup.markUp('a'); // reconnected (admin, refresh) while the probe was in flight
  await h.probeFail();
  assert.equal(h.sup.status('a').state, 'up');
  assert.equal(h.sup.status('a').probe.consecutiveFailures, 0);
});

test('probeEnabled=false turns probes off for that backend only', async () => {
  const h = harness({ probeEnabled: (b) => b !== 'quiet' });
  h.sup.markUp('quiet');
  h.sup.markUp('loud');
  assert.equal(h.sup.status('quiet').probe.enabled, false);
  assert.equal(h.sup.status('loud').probe.enabled, true);
  await h.advance(INTERVAL);
  assert.deepEqual(h.probes.map(p => p.backend), ['loud']);
});

test('stop() ends probing', async () => {
  const h = harness();
  h.sup.markUp('a');
  h.sup.stop();
  await h.advance(10 * INTERVAL);
  assert.equal(h.probes.length, 0);
});

test('the settings expose the probe configuration', () => {
  const h = harness();
  const { probeIntervalMs, probeTimeoutMs, probeFailures, probeConcurrency } = h.sup.settings;
  assert.deepEqual({ probeIntervalMs, probeTimeoutMs, probeFailures, probeConcurrency },
    { probeIntervalMs: INTERVAL, probeTimeoutMs: TIMEOUT, probeFailures: 3, probeConcurrency: 10 });
});
