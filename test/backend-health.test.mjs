// BackendSupervisor (backendHealth.ts) on a fake clock: backoff and jitter,
// reconnect success and failure, flap protection, the concurrency cap, admin
// reconnect, reset and forget. The gateway wiring is in backend-recovery.test.mjs.
//
// Run from the fork root after a build:  node --test test/backend-health.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendSupervisor, unavailableMessage } from '../build/backendHealth.js';

/** A supervisor on a fake clock whose reconnects are settled by hand. */
function harness(opts = {}) {
  let now = 1_000_000;
  const timers = [];
  const pending = []; // { backend, resolve, reject }
  const events = [];
  const sup = new BackendSupervisor({
    baseMs: 1000, maxMs: 60_000, flapMax: 3, flapWindowMs: 10 * 60_000, maxConcurrent: 10,
    random: () => 1,
    ...opts,
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
    reconnect: (backend, stillWanted) => new Promise((resolve, reject) => pending.push({ backend, resolve, reject, stillWanted })),
    onTransition: (t) => events.push(t),
  });
  const flush = () => new Promise(r => setImmediate(r));
  return {
    sup, timers, pending, events, flush,
    advance: async (ms) => {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
      }
      await flush();
    },
    settle: async (ok, err = 'boom') => { const p = pending.shift(); ok ? p.resolve() : p.reject(new Error(err)); await flush(); await flush(); },
  };
}

test('backoff doubles from the base, is capped, and jitter scales it into [0.5, 1]', () => {
  const full = harness({ random: () => 1 }).sup;
  assert.deepEqual([1, 2, 3, 4, 7, 8, 20].map(n => full.delayFor(n)), [1000, 2000, 4000, 8000, 60_000, 60_000, 60_000]);
  const low = harness({ random: () => 0 }).sup;
  assert.deepEqual([1, 2, 7].map(n => low.delayFor(n)), [500, 1000, 30_000]);
});

test('a crash schedules a reconnect; success marks it up again', async () => {
  const h = harness();
  h.sup.markUp('a');
  assert.equal(h.sup.isUp('a'), true);
  h.sup.reportDown('a', 'stdio process exited');
  assert.equal(h.sup.status('a').state, 'reconnecting');
  assert.equal(h.sup.status('a').lastError, 'stdio process exited');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 1000);
  await h.advance(999);
  assert.equal(h.pending.length, 0, 'not before its time');
  await h.advance(1);
  assert.equal(h.pending.length, 1);
  await h.settle(true);
  assert.equal(h.sup.status('a').state, 'up');
  assert.deepEqual(h.events.map(e => e.action), ['down', 'reconnected']);
  assert.equal(h.events[1].attempts, 1);
});

test('failed attempts back off further, and a second reportDown while down is not another crash', async () => {
  const h = harness();
  h.sup.markUp('a');
  h.sup.reportDown('a', 'exit');
  h.sup.reportDown('a', 'exit again');
  assert.equal(h.sup.status('a').recentCrashes, 1);
  await h.advance(1000);
  await h.settle(false);
  assert.equal(h.sup.status('a').attempt, 1);
  assert.equal(h.timers[0].ms, 2000);
  await h.advance(2000);
  await h.settle(false);
  assert.equal(h.timers[0].ms, 4000);
  assert.equal(h.sup.status('a').lastError, 'boom');
  assert.ok(h.sup.status('a').nextRetryAt);
  await h.advance(4000);
  await h.settle(true);
  assert.equal(h.sup.status('a').state, 'up');
  assert.equal(h.events.at(-1).attempts, 3);
});

test('flap protection: N crashes within the window marks it failed and stops retrying', async () => {
  const h = harness();
  h.sup.markUp('a');
  for (let i = 0; i < 2; i++) {
    h.sup.reportDown('a', `crash ${i}`);
    await h.advance(1000);
    await h.settle(true);
  }
  h.sup.reportDown('a', 'crash 2');
  const s = h.sup.status('a');
  assert.equal(s.state, 'failed');
  assert.equal(h.timers.length, 0, 'no more automatic attempts');
  assert.equal(h.events.at(-1).action, 'failed');
  assert.equal(h.events.at(-1).recentCrashes, 3);
  assert.match(unavailableMessage(s, 10), /failed after repeated crashes \(3 in 10 min\).*an admin must reconnect it/);
  await h.advance(10 * 60_000);
  assert.equal(h.pending.length, 0);
  assert.equal(h.sup.status('a').state, 'failed', 'stays failed until an admin acts');
});

test('crashes older than the window do not count', async () => {
  const h = harness();
  h.sup.markUp('a');
  for (let i = 0; i < 4; i++) {
    h.sup.reportDown('a', 'crash');
    await h.advance(1000);
    await h.settle(true);
    await h.advance(6 * 60_000);
  }
  assert.equal(h.sup.status('a').state, 'up');
});

test('connect failures back off but are not crashes', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    if (i === 0) h.sup.reportConnectFailed('a', 'ENOENT');
    await h.advance(60_000);
    await h.settle(false);
  }
  assert.equal(h.sup.status('a').state, 'reconnecting');
  assert.equal(h.sup.status('a').recentCrashes, 0);
  assert.deepEqual(h.events.map(e => e.action), ['connect-failed']);
  assert.match(unavailableMessage(h.sup.status('a'), 10), /^Backend "a" is down since .* \(reconnecting, attempt 5; next try at /);
});

test('at most maxConcurrent reconnects run at once', async () => {
  const h = harness({ maxConcurrent: 2 });
  for (const b of ['a', 'b', 'c', 'd', 'e']) { h.sup.markUp(b); h.sup.reportDown(b, 'net blip'); }
  await h.advance(1000);
  assert.equal(h.pending.length, 2);
  await h.settle(true);
  assert.equal(h.pending.length, 2, 'the next queued one starts as a slot frees');
  await h.settle(true); await h.settle(true); await h.settle(true);
  assert.equal(h.pending.length, 1);
  await h.settle(true);
  assert.ok(['a', 'b', 'c', 'd', 'e'].every(b => h.sup.isUp(b)));
});

test('admin reconnect revives a failed backend and clears its crash history', async () => {
  const h = harness({ flapMax: 1 });
  h.sup.markUp('a');
  h.sup.reportDown('a', 'crash');
  assert.equal(h.sup.status('a').state, 'failed');
  const p = h.sup.reconnectNow('a', 'alice');
  await h.flush(); await h.flush();
  assert.equal(h.pending.length, 1);
  h.pending.shift().resolve();
  const s = await p;
  assert.equal(s.state, 'up');
  assert.equal(s.recentCrashes, 0);
  assert.deepEqual(h.events.map(e => e.action), ['failed', 'reconnected', 'admin-reconnect']);
  assert.equal(h.events.at(-1).admin, 'alice');
  assert.equal(h.events.at(-1).ok, true);
});

test('a failed admin reconnect goes back to automatic retries', async () => {
  const h = harness({ flapMax: 1 });
  h.sup.markUp('a');
  h.sup.reportDown('a', 'crash');
  const p = h.sup.reconnectNow('a', 'alice');
  await h.flush(); await h.flush();
  h.pending.shift().reject(new Error('still broken'));
  const s = await p;
  assert.equal(s.state, 'reconnecting');
  assert.equal(s.lastError, 'still broken');
  assert.equal(h.timers.length, 1);
  assert.equal(h.events.at(-1).ok, false);
});

test('reset cancels the timer and turns failed into reconnecting; forget drops the backend', async () => {
  const h = harness({ flapMax: 1 });
  h.sup.markUp('a');
  h.sup.markUp('b');
  h.sup.reportDown('a', 'crash');
  await h.sup.reset('a');
  assert.equal(h.sup.status('a').state, 'reconnecting');
  h.sup.reportDown('b', 'crash');
  h.sup.markUp('b');
  h.sup.reportDown('b', 'x'); // flapMax 1: failed at once
  h.sup.forget('b');
  assert.equal(h.sup.status('b'), undefined);
  assert.equal(h.sup.isUp('b'), true, 'an unknown backend is not reported down');
  h.sup.reportConnectFailed('a', 'nope');
  assert.equal(h.timers.length, 1);
  await h.sup.reset('a');
  assert.equal(h.timers.length, 0);
});

test('a stale attempt (reset while in flight) does not mark the backend up', async () => {
  const h = harness();
  h.sup.markUp('a');
  h.sup.reportDown('a', 'crash');
  await h.advance(1000);
  assert.equal(h.pending.length, 1);
  const resetting = h.sup.reset('a');
  await h.settle(true);
  await resetting;
  assert.equal(h.sup.status('a').state, 'reconnecting', 'the reload that reset it decides');
});

test('a backend that exits right after reconnecting is not marked up', async () => {
  let alive = false;
  const h = harness({ alive: () => alive });
  h.sup.markUp('a');
  h.sup.reportDown('a', 'crash');
  await h.advance(1000);
  await h.settle(true);
  assert.equal(h.sup.status('a').state, 'reconnecting');
  assert.equal(h.sup.status('a').lastError, 'the backend exited right after connecting');
  assert.equal(h.timers.length, 1, 'retried with backoff');
  alive = true;
  await h.advance(2000);
  await h.settle(true);
  assert.equal(h.sup.status('a').state, 'up');
});

test('two admin reconnects at once share one attempt (single flight)', async () => {
  const h = harness();
  h.sup.markUp('a');
  const p1 = h.sup.reconnectNow('a', 'alice');
  const p2 = h.sup.reconnectNow('a', 'bob');
  await h.flush(); await h.flush();
  assert.equal(h.pending.length, 1, 'one reconnect, not two');
  h.pending.shift().resolve();
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1.state, 'up');
  assert.equal(s2.state, 'up');
  await h.flush();
  assert.equal(h.pending.length, 0);
  assert.deepEqual(h.events.filter(e => e.action === 'admin-reconnect').map(e => [e.admin, e.ok]), [['alice', true], ['bob', true]]);
});

test('reset (a reload) waits for an admin reconnect in flight', async () => {
  const h = harness();
  h.sup.markUp('a');
  const admin = h.sup.reconnectNow('a', 'alice');
  await h.flush(); await h.flush();
  assert.equal(h.pending.length, 1);
  let resetDone = false;
  const resetting = h.sup.reset('a').then(() => { resetDone = true; });
  await h.flush(); await h.flush();
  assert.equal(resetDone, false, 'the reload waits for the manual attempt');
  h.pending.shift().resolve();
  await admin;
  await resetting;
  assert.equal(resetDone, true);
});

test('the reconnect callback can tell when its attempt is no longer wanted', async () => {
  const h = harness();
  h.sup.markUp('a');
  h.sup.reportDown('a', 'crash');
  await h.advance(1000);
  assert.equal(h.pending.length, 1);
  const auto = h.pending[0].stillWanted;
  assert.equal(auto(), true);
  h.sup.forget('a');
  assert.equal(auto(), false, 'a forgotten backend is not reconnected');
  h.sup.markUp('b');
  h.sup.reconnectNow('b', 'alice');
  await h.flush(); await h.flush();
  assert.equal(h.pending.length, 2);
  const manual = h.pending[1].stillWanted;
  assert.equal(manual(), true);
  h.sup.forget('b');
  assert.equal(manual(), false);
});

test('R2: a backend forgotten while an admin reconnect waits in reset() is not recreated or retried', async () => {
  const h = harness();
  h.sup.markUp('removed');
  const op = h.sup.reconnectNow('removed', 'alice');
  h.sup.forget('removed');
  await h.flush(); await h.flush();
  assert.equal(h.pending.length, 0, 'no reconnect callback ran');
  assert.equal(await op, undefined, 'the admin caller is told it is gone');
  assert.equal(h.sup.status('removed'), undefined, 'no record recreated');
  assert.equal(h.timers.length, 0, 'no retry scheduled');
  assert.equal(h.events.filter(e => e.backend === 'removed' && e.action === 'admin-reconnect').length, 0);
});

test('R2: a backend forgotten while its admin reconnect is queued for a slot never runs', async () => {
  const h = harness({ maxConcurrent: 1 });
  h.sup.markUp('a');
  h.sup.reportDown('a', 'crash');
  await h.advance(1000);
  assert.equal(h.pending.length, 1, 'a holds the only slot');
  h.sup.markUp('b');
  const op = h.sup.reconnectNow('b', 'alice');
  await h.flush(); await h.flush();
  assert.equal(h.pending.length, 1, 'b is queued');
  h.sup.forget('b');
  await h.settle(true);
  assert.equal(h.pending.length, 0, 'the queued slot did not call reconnect');
  assert.equal(await op, undefined);
  assert.equal(h.sup.status('b'), undefined);
  assert.equal(h.timers.length, 0);
});

test('R2: an admin reconnect does not run or schedule after the supervisor stopped', async () => {
  const h = harness();
  h.sup.markUp('a');
  h.sup.reconnectNow('a', 'alice');
  h.sup.stop();
  await h.flush(); await h.flush();
  assert.equal(h.pending.length, 0, 'no reconnect callback ran');
  assert.equal(h.timers.length, 0);
});
