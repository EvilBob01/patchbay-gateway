// Health probes end to end through the gateway (mcp-proxy.ts): a backend that
// stays connected but stops answering MCP is detected by the periodic probe,
// reported down, reconnected and works again; probes use ping (tools/list when
// ping is not supported); a probe never runs alongside a reconnect; readiness
// follows the required backends only; removed backends stop being probed.
//
// The fake backend's --hang-if-pid swallows every request while a file holds
// its pid, so only the hung process hangs and its replacement answers.
//
// Run from the fork root after a build:  node --test test/health-probes-gateway.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway, fakeBackend, who, echoed } from './fixtures/gateway.mjs';

const work = mkdtempSync(path.join(tmpdir(), 'probes-work-'));
const f = (name) => path.join(work, name);
const watched = (name, ...more) => fakeBackend(name, 'ssh-mcp', `--pidfile=${f(`${name}.pid`)}`, `--fail-if=${f(`${name}.block`)}`, `--pinglog=${f(`${name}.pings`)}`, ...more);

const INTERVAL_MS = 200;
const TIMEOUT_MS = 150;
const FAILURES = 2;

const servers = {
  hangy: watched('hangy', `--hang-if-pid=${f('hang')}`),
  steady: watched('steady'),
  noping: watched('noping', '--no-ping'),
  slow: watched('slow', '--start-delay-ms=600'),
  lazyb: { ...watched('lazyb'), lazy: true },
  opt: { ...watched('opt'), required: false },
  quiet: { ...watched('quiet'), probe: false },
};
const gw = await startGateway({
  prefix: 'probes-',
  servers,
  policy: { default: { allow: ['*'] } },
  env: {
    MCP_BACKEND_RECONNECT_BASE_MS: '100',
    MCP_BACKEND_RECONNECT_MAX_MS: '400',
    MCP_BACKEND_FLAP_MAX: '5',
    MCP_BACKEND_PROBE_INTERVAL_S: String(INTERVAL_MS / 1000),
    MCP_BACKEND_PROBE_TIMEOUT_MS: String(TIMEOUT_MS),
    MCP_BACKEND_PROBE_FAILURES: String(FAILURES),
  },
});
const { P } = gw;
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const { loadToolConfig } = await import(pathToFileURL(path.join(BUILD, 'config.js')).href);
test.after(async () => { await gw.stop(); rmSync(work, { recursive: true, force: true }); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const state = (b) => P.getBackendStatus().backends.find(x => x.backend === b);
async function waitFor(pred, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return; await sleep(20); }
  assert.fail(`timed out waiting for ${what}: ${JSON.stringify(P.getBackendStatus().backends)}`);
}
const pidOf = (b) => Number(readFileSync(f(`${b}.pid`), 'utf-8'));
const pings = (b) => existsSync(f(`${b}.pings`)) ? readFileSync(f(`${b}.pings`), 'utf-8').split('\n').filter(Boolean).length : 0;

test('the status API reports required, lazy, probe state and readiness', async () => {
  const s = P.getBackendStatus();
  assert.equal(s.ready, true);
  assert.equal(s.initialized, true);
  const by = Object.fromEntries(s.backends.map(b => [b.backend, b]));
  assert.equal(by.hangy.required, true, 'eager backends default to required');
  assert.equal(by.hangy.lazy, false);
  assert.equal(by.lazyb.required, false, 'lazy backends default to optional');
  assert.equal(by.lazyb.lazy, true);
  assert.equal(by.opt.required, false, 'explicit required:false');
  for (const b of Object.keys(servers)) {
    assert.equal(typeof by[b].probe, 'object', b);
    assert.equal(by[b].probe.enabled, b !== 'quiet', b);
    assert.equal(typeof by[b].probe.consecutiveFailures, 'number', b);
  }
  assert.equal(s.settings.probeIntervalS, INTERVAL_MS / 1000);
  assert.equal(s.settings.probeTimeoutMs, TIMEOUT_MS);
  assert.equal(s.settings.probeFailures, FAILURES);
  assert.equal(typeof s.settings.probeConcurrency, 'number');
});

test('probes use ping, fall back to tools/list without ping, and skip probe:false backends', async () => {
  const before = pings('steady');
  await waitFor(() => pings('steady') >= before + 2, 'two pings to steady');
  await waitFor(() => state('lazyb').probe.lastOk === true, 'a lazy backend is probed too');
  await waitFor(() => state('noping').probe.lastOk === true, 'noping probed through tools/list');
  assert.equal(state('noping').state, 'up');
  assert.equal(state('noping').probe.consecutiveFailures, 0);
  assert.equal(pings('quiet'), 0, 'probe:false: never pinged');
  assert.equal(state('quiet').probe.lastAt, undefined);
  assert.ok(state('steady').probe.lastAt, 'last probe time recorded');
  assert.equal(typeof state('steady').probe.lastMs, 'number');
});

test('a hung backend is detected within about interval x threshold, reconnected, and works afterwards', async () => {
  const s = await gw.session(who('plain'));
  assert.equal(echoed(await s.call('hangy__read-command', { command: 'uptime' })).backend, 'hangy');
  const oldPid = pidOf('hangy');
  writeFileSync(f('hang'), String(oldPid));
  const t0 = Date.now();
  await waitFor(() => state('hangy').state !== 'up', 'hangy reported down');
  const detectMs = Date.now() - t0;
  // Up to one interval to the next probe, then FAILURES probes each waiting
  // TIMEOUT_MS, one interval (+10% jitter) apart. Generous slack for CI.
  const bound = FAILURES * (INTERVAL_MS * 1.1 + TIMEOUT_MS) + INTERVAL_MS + 1500;
  assert.ok(detectMs <= bound, `detected in ${detectMs} ms, bound ${bound} ms`);
  assert.match(state('hangy').lastError, /^probe: no answer \(2 in a row\)/);

  await waitFor(() => state('hangy').state === 'up', 'hangy reconnected');
  assert.notEqual(pidOf('hangy'), oldPid, 'a fresh process');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await waitFor(() => !alive(oldPid), 'the hung process to be gone (retired, not leaked)');
  assert.equal(state('hangy').probe.consecutiveFailures, 0);
  const res = await s.call('hangy__read-command', { command: 'uptime' });
  assert.equal(echoed(res).backend, 'hangy', JSON.stringify(res));

  const down = (await gw.auditLines()).filter(l => l.event === 'backend' && l.backend === 'hangy' && l.action === 'down');
  assert.equal(down.length, 1);
  assert.equal(down[0].cause, 'probe');
  assert.match(down[0].reason, /^probe: /);
  try { unlinkSync(f('hang')); } catch { /* gone */ }
});

test('a probe never runs alongside a reconnect: it is skipped while the connection lock is held', async () => {
  const reconnecting = P.reconnectBackendNow('slow', 'tester'); // ~600 ms to start
  await sleep(50);
  assert.equal(await P.probeBackend('slow'), false, 'skipped during an admin reconnect');
  const st = await reconnecting;
  assert.equal(st.state, 'up');
  assert.equal(await P.probeBackend('slow'), true, 'probed once the reconnect is done');
});

test('readiness flips for a required backend and not for an optional one', async () => {
  assert.equal(P.getReadiness().ready, true);
  const total = P.getReadiness().required.total;

  // Optional backend down: still ready, reported separately.
  writeFileSync(f('opt.block'), '');
  process.kill(pidOf('opt'));
  await waitFor(() => state('opt').state !== 'up', 'opt down');
  let r = P.getReadiness();
  assert.equal(r.ready, true);
  assert.equal(r.optional.up, r.optional.total - 1);
  assert.deepEqual(r.notUp.map(n => [n.backend, n.required]), [['opt', false]]);

  // Required backend down: not ready.
  writeFileSync(f('steady.block'), '');
  process.kill(pidOf('steady'));
  await waitFor(() => state('steady').state !== 'up', 'steady down');
  r = P.getReadiness();
  assert.equal(r.ready, false);
  assert.deepEqual(r.required, { up: total - 1, total });
  assert.ok(r.notUp.some(n => n.backend === 'steady' && n.required === true));

  unlinkSync(f('steady.block'));
  unlinkSync(f('opt.block'));
  await waitFor(() => state('steady').state === 'up' && state('opt').state === 'up', 'both back');
  assert.equal(P.getReadiness().ready, true);
});

test('a removed backend stops being probed', async () => {
  const { steady: _gone, ...rest } = servers;
  await P.updateBackendConnections({ mcpServers: rest }, await loadToolConfig());
  assert.equal(state('steady'), undefined);
  assert.equal(await P.probeBackend('steady'), false);
  const n = pings('steady');
  await sleep(INTERVAL_MS * 4);
  assert.equal(pings('steady'), n, 'no pings after removal');
  assert.equal(P.getReadiness().notUp.length, 0, 'a removed backend does not count against readiness');
});
