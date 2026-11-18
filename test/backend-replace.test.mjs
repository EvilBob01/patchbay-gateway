// Planned replacement of a backend's connection (a reload that changes its
// config, an admin reconnect): readiness and calls must not treat the backend
// as up while the old connection is gone and the new one is not ready yet.
// A planned replacement is not a crash: no flap count, no "down" audit line.
//
// Review finding 2 (v1.2.0-rc1): /readyz stayed 200 while a reload replaced a
// required backend, and calls in that gap went to the retired connection.
//
// Run from the fork root after a build:  node --test test/backend-replace.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startGateway, fakeBackend, who } from './fixtures/gateway.mjs';

const work = mkdtempSync(path.join(tmpdir(), 'replace-work-'));
const f = (name) => path.join(work, name);
const slow = (name, ms = 1500) => fakeBackend(name, 'ssh-mcp', `--fail-if=${f(`${name}.block`)}`, `--start-delay-ms=${ms}`);
const plain = (name) => fakeBackend(name, 'ssh-mcp', `--fail-if=${f(`${name}.block`)}`);

const SERVERS = {
  reqa: plain('reqa'),
  reqslow: slow('reqslow', 1200),
  opt: { ...plain('opt'), required: false },
};
const gw = await startGateway({
  prefix: 'replace-',
  servers: SERVERS,
  policy: { default: { allow: ['*'] } },
  env: { MCP_BACKEND_PROBE_INTERVAL_S: '0', MCP_BACKEND_RECONNECT_BASE_MS: '60000', MCP_BACKEND_RECONNECT_MAX_MS: '60000' },
});
const { P } = gw;
test.after(async () => { await gw.stop(); rmSync(work, { recursive: true, force: true }); });

const DOWN = -32013;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const state = (b) => P.getBackendStatus().backends.find(x => x.backend === b);
const backendAudit = async (b) => (await gw.auditLines()).filter(l => l.event === 'backend' && l.backend === b);
let config = structuredClone(SERVERS);
const reload = (servers) => { config = servers; return P.updateBackendConnections({ mcpServers: servers }, { tools: {} }); };

async function waitFor(pred, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return; await sleep(20); }
  assert.fail(`timed out waiting for ${what}: ${JSON.stringify(P.getBackendStatus().backends)}`);
}

/** Sample readiness until `done` settles; returns every sample. */
async function sampleUntil(done) {
  let settled = false;
  const p = done.then(v => { settled = true; return v; }, e => { settled = true; throw e; });
  const samples = [];
  while (!settled) { samples.push(P.getReadiness()); await sleep(20); }
  return { samples, result: await p };
}

test('startup: every backend up, ready', async () => {
  await waitFor(() => P.getReadiness().ready, 'initial readiness');
  for (const b of ['reqa', 'reqslow', 'opt']) assert.equal(state(b).state, 'up');
});

test('a reload replacing a required backend with a slow start: not ready until the new connection is up', async () => {
  const s = await gw.session(who('plain'));
  const changed = { ...config, reqa: slow('reqa', 1500) };
  let settled = false;
  const pending = reload(changed).then(() => { settled = true; });
  await sleep(400);
  assert.equal(settled, false, 'the reload is still connecting');
  const during = P.getReadiness();
  assert.equal(during.ready, false, `readiness during the replacement: ${JSON.stringify(during)}`);
  assert.deepEqual(during.notUp.map(n => [n.backend, n.required]), [['reqa', true]]);
  assert.equal(state('reqa').state, 'reconnecting');
  assert.equal(state('reqa').replacing, 'reload');

  const call = await s.call('reqa__read-command', { command: 'uptime' });
  assert.equal(call.error?.code, DOWN, `a call in the gap gets the backend-unavailable error: ${JSON.stringify(call)}`);
  assert.match(call.error.message, /reconnecting \(config reload\)/);

  await pending;
  assert.equal(state('reqa').state, 'up');
  assert.equal(state('reqa').replacing, undefined);
  assert.equal(state('reqa').recentCrashes, 0, 'a planned replacement is not a crash');
  assert.equal(P.getReadiness().ready, true);
  const ok = await s.call('reqa__read-command', { command: 'uptime' });
  assert.ok(!ok.error, JSON.stringify(ok));

  const lines = await backendAudit('reqa');
  assert.deepEqual(lines.map(l => l.action), ['replacing', 'replaced']);
  assert.equal(lines[0].by, 'reload');
  assert.ok(lines[1].ms >= 1000, `replaced after ${lines[1].ms} ms`);
});

test('an admin reconnect of a required backend: not ready while it reconnects, up again after', async () => {
  const { samples, result } = await sampleUntil(P.reconnectBackendNow('reqslow', 'tester'));
  assert.equal(result.state, 'up');
  assert.ok(samples.some(r => !r.ready && r.notUp.some(n => n.backend === 'reqslow')),
    `readiness dropped during the reconnect: ${JSON.stringify(samples.map(r => r.ready))}`);
  assert.equal(P.getReadiness().ready, true);
  assert.equal(state('reqslow').recentCrashes, 0);
  const actions = (await backendAudit('reqslow')).map(l => l.action);
  assert.deepEqual(actions, ['replacing', 'replaced', 'admin-reconnect']);
  assert.ok(!actions.includes('down'));
});

test('a failure during replacement goes to the reconnect path, without a crash', async () => {
  writeFileSync(f('reqslow.block'), '');
  try {
    const st = await P.reconnectBackendNow('reqslow', 'tester');
    assert.equal(st.state, 'reconnecting');
    assert.equal(st.recentCrashes, 0);
    assert.equal(st.replacing, undefined, 'no longer a planned replacement: normal backoff');
    assert.ok(st.nextRetryAt, 'an automatic retry is scheduled');
    assert.equal(P.getReadiness().ready, false);
    const lines = (await backendAudit('reqslow')).slice(3);
    assert.deepEqual(lines.map(l => l.action), ['replacing', 'connect-failed', 'admin-reconnect']);
    assert.equal(lines[2].ok, false);

    // A reload that changes a backend that then can't connect: the same path.
    writeFileSync(f('reqa.block'), '');
    await reload({ ...config, reqa: plain('reqa') });
    assert.equal(state('reqa').state, 'reconnecting');
    assert.equal(state('reqa').recentCrashes, 0);
    assert.deepEqual((await backendAudit('reqa')).slice(2).map(l => l.action), ['replacing', 'connect-failed']);
  } finally {
    rmSync(f('reqslow.block'), { force: true });
    rmSync(f('reqa.block'), { force: true });
  }
  assert.equal((await P.reconnectBackendNow('reqslow', 'tester')).state, 'up');
  assert.equal((await P.reconnectBackendNow('reqa', 'tester')).state, 'up');
  assert.equal(P.getReadiness().ready, true);
});

test('replacing an optional backend keeps the gateway ready', async () => {
  const { samples } = await sampleUntil(reload({ ...config, opt: { ...slow('opt', 1000), required: false } }));
  assert.ok(samples.length > 5, `sampled ${samples.length} times`);
  assert.ok(samples.every(r => r.ready), `readiness during an optional replacement: ${JSON.stringify(samples.map(r => r.ready))}`);
  assert.ok(samples.some(r => r.optional.up < r.optional.total), 'the optional backend was counted as not up meanwhile');
  assert.equal(state('opt').state, 'up');
});

test('an unchanged reload does not touch a healthy backend', async () => {
  const before = (await backendAudit('reqa')).length;
  await reload(config);
  assert.equal(state('reqa').state, 'up');
  assert.equal((await backendAudit('reqa')).length, before);
});
