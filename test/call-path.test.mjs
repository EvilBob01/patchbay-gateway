// The tools/call path and backend connection lifecycle, end to end through the
// gateway (v1.1 review findings B1, S2, B3):
//
//   - B1: a retry is checked again right before it is sent. A tool whose
//     definition changed during the retry delay (and is now held by the tool
//     pins) is refused with -32012 and never reaches the backend a second time,
//     on a direct call and through the lazy call_read.
//   - S2: only tools classed read are retried automatically. A write that
//     times out is returned to the client after one attempt.
//   - B3: concurrent admin reconnects, and an admin reconnect racing a reload,
//     leave exactly one live backend process.
//
// The backend (fixtures/call-path-backend.mjs) logs every tools/call it
// executes and every pid it starts as.
//
// Run from the fork root after a build:  node --test test/call-path.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway, who } from './fixtures/gateway.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'call-path-backend.mjs');
const work = mkdtempSync(path.join(tmpdir(), 'call-path-work-'));
const f = (name) => path.join(work, name);
const backend = (name, ...flags) =>
  ({ type: 'stdio', command: process.execPath, args: [FIXTURE, `--name=${name}`, `--calls=${f(`${name}.calls`)}`, ...flags] });

const servers = {
  direct: backend('direct'),
  lazyp: { ...backend('lazyp'), lazy: true },
  rc: backend('rc', `--pidlog=${f('rc.pids')}`),
};
const gw = await startGateway({
  prefix: 'call-path-',
  servers,
  policy: { default: { allow: ['*'] } },
  // Longer than the backend's tools/list_changed debounce (200 ms) plus a re-list,
  // so the hold is in place before the retry is due.
  env: { STDIO_TOOL_CALL_RETRY_DELAY_BASE_MS: '800', STDIO_TOOL_CALL_MAX_RETRIES: '2' },
});
const { P } = gw;
const BUILD = path.join(here, '..', 'build');
const { loadConfig, loadToolConfig } = await import(pathToFileURL(path.join(BUILD, 'config.js')).href);

const allPids = () => existsSync(f('rc.pids')) ? readFileSync(f('rc.pids'), 'utf-8').trim().split('\n').filter(Boolean).map(Number) : [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
test.after(async () => {
  await gw.stop();
  for (const pid of allPids()) { try { process.kill(pid); } catch { /* gone */ } }
  rmSync(work, { recursive: true, force: true });
});

const USER = who('caller');
const HELD = -32012;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const calls = (b, tool) => existsSync(f(`${b}.calls`))
  ? readFileSync(f(`${b}.calls`), 'utf-8').split('\n').filter(l => l === tool).length : 0;
const held = (b, tool) => P.getToolPinState().pending.some(p => p.backend === b && p.tool === tool);
const lastAudit = async (sessionId) => (await gw.auditFor(sessionId)).filter(l => l.event === 'tools/call').at(-1);

/** Live rc processes, once any retired one has had time to exit. */
async function liveRc() {
  const end = Date.now() + 4000;
  let live;
  do {
    live = allPids().filter(alive);
    if (live.length <= 1) return live;
    await sleep(50);
  } while (Date.now() < end);
  return live;
}

test('B1: a definition change during the retry delay holds the tool, and the retry is refused (direct call)', async () => {
  const s = await gw.session(USER);
  const res = await s.call('direct__probe', {});
  assert.equal(res.error?.code, HELD, JSON.stringify(res));
  assert.ok(held('direct', 'probe'), 'the changed definition is held');
  assert.equal(calls('direct', 'probe'), 1, 'the backend saw no second call');
  const line = await lastAudit(s.sessionId);
  assert.equal(line.ok, false);
  assert.equal(line.errorCode, HELD);
  assert.equal(line.attempts, 1);
  assert.equal(line.retryRefused, 'held');
});

test('B1: the same through the lazy call_read', async () => {
  const s = await gw.session(USER);
  const res = await s.rpc('tools/call', { name: 'patchbay__call_read', arguments: { tool: 'lazyp/probe', arguments: {} } });
  assert.equal(res.error?.code, HELD, JSON.stringify(res));
  assert.ok(held('lazyp', 'probe'));
  assert.equal(calls('lazyp', 'probe'), 1, 'the backend saw no second call');
  const line = await lastAudit(s.sessionId);
  assert.equal(line.via, 'call_read');
  assert.equal(line.retryRefused, 'held');
});

test('S2: a write tool that times out is not replayed', async () => {
  const s = await gw.session(USER);
  const res = await s.call('direct__writer', {});
  assert.equal(res.error?.code, -32001, JSON.stringify(res));
  assert.match(res.error.message, /not retried/);
  assert.equal(res.error.data?.notRetried?.reason, 'not-read');
  assert.equal(calls('direct', 'writer'), 1, 'exactly one attempt reached the backend');
  const line = await lastAudit(s.sessionId);
  assert.equal(line.attempts, 1);
  assert.equal(line.retryRefused, 'not-read');
});

test('S2: a write through call_write is not replayed either', async () => {
  const s = await gw.session(USER);
  const res = await s.rpc('tools/call', { name: 'patchbay__call_write', arguments: { tool: 'lazyp/writer', arguments: {} } });
  assert.equal(res.error?.code, -32001, JSON.stringify(res));
  assert.equal(calls('lazyp', 'writer'), 1);
});

test('S2: a read tool that times out is still retried', async () => {
  const s = await gw.session(USER);
  const res = await s.call('direct__flaky-read', {});
  assert.ok(res.result, JSON.stringify(res));
  assert.match(res.result.content[0].text, /flaky-read executed/);
  assert.equal(calls('direct', 'flaky-read'), 2);
  const line = await lastAudit(s.sessionId);
  assert.equal(line.ok, true);
  assert.equal(line.attempts, 2);
  assert.equal(line.retryRefused, undefined);
});

test('B3: two concurrent admin reconnects leave exactly one backend process', async () => {
  const [a, b] = await Promise.all([P.reconnectBackendNow('rc', 'admin1'), P.reconnectBackendNow('rc', 'admin2')]);
  assert.equal(a.state, 'up');
  assert.equal(b.state, 'up');
  const live = await liveRc();
  assert.equal(live.length, 1, `live rc processes: ${live.join(', ')} of ${allPids().join(', ')}`);
  const s = await gw.session(USER);
  const res = await s.call('rc__echo', {});
  assert.match(res.result?.content[0].text ?? JSON.stringify(res), /"backend":"rc"/);
});

test('B3: an admin reconnect racing a reload that respawns the backend leaves exactly one process', async () => {
  const cfgPath = path.join(gw.dir, 'config', 'mcp_server.json');
  const changed = { ...servers, rc: backend('rc', `--pidlog=${f('rc.pids')}`, '--tag=2') };
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: changed }));
  await Promise.all([
    P.reconnectBackendNow('rc', 'admin1'),
    (async () => P.updateBackendConnections(await loadConfig(), await loadToolConfig()))(),
    P.reconnectBackendNow('rc', 'admin2'),
  ]);
  const live = await liveRc();
  assert.equal(live.length, 1, `live rc processes: ${live.join(', ')} of ${allPids().join(', ')}`);
  const s = await gw.session(USER);
  const res = await s.call('rc__echo', {});
  assert.match(res.result?.content[0].text ?? JSON.stringify(res), /"backend":"rc"/);
  assert.equal(P.getBackendStatus().backends.find(x => x.backend === 'rc').state, 'up');
});

test('B3: a reconnect of a backend that a reload removes does not spawn it again', async () => {
  const cfgPath = path.join(gw.dir, 'config', 'mcp_server.json');
  const { rc: _gone, ...rest } = servers;
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: rest }));
  const results = await Promise.allSettled([
    (async () => P.updateBackendConnections(await loadConfig(), await loadToolConfig()))(),
    P.reconnectBackendNow('rc', 'admin1'),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  const live = await (async () => {
    const end = Date.now() + 4000;
    let l;
    do { l = allPids().filter(alive); if (l.length === 0) return l; await sleep(50); } while (Date.now() < end);
    return l;
  })();
  assert.equal(live.length, 0, `rc was removed, yet processes are alive: ${live.join(', ')}`);
  assert.equal(P.getBackendStatus().backends.find(x => x.backend === 'rc'), undefined);
});
