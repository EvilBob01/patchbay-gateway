// Rug-pull protection toggles: MCP_PIN_TOOLS=false is today's behaviour;
// a corrupt pin file fails closed. One gateway per file (env read at import),
// so the fail-closed case is a child process.
//
// Run from the fork root after a build:  node --test test/tool-pins-modes.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startGateway, fakeBackend, who } from './fixtures/gateway.mjs';

if (process.env.PINS_CHILD === 'corrupt') {
  // The pin file is written raw (PINS_RAW) by startGateway before the import.
  const gw = await startGateway({ prefix: 'pins-bad-', servers: { web01: fakeBackend('web01') } });
  const s = await gw.session(who('carol'));
  const tools = await s.list();
  const res = await s.call('web01__run-command', { command: 'id' });
  process.stdout.write('@@RESULT@@' + JSON.stringify({ count: tools.length, code: res.error?.code, error: gw.P.getToolPinState().error ?? null }));
  await gw.stop();
  process.exit(0);
}

test('MCP_PIN_TOOLS=false: nothing pinned, nothing written, changes are not held', async () => {
  const gw = await startGateway({ prefix: 'pins-off-', servers: { web01: fakeBackend('web01') }, env: { MCP_PIN_TOOLS: 'false' } });
  const s = await gw.session(who('carol'));
  assert.ok((await s.list()).some(t => t.name === 'web01__run-command'));
  assert.equal(existsSync(gw.pinsPath), false);
  assert.deepEqual(gw.P.getToolPinState(), { enabled: false });
  await gw.stop();
});

test('corrupt pin file fails closed: no tools, calls say pending, error surfaced', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, PINS_CHILD: 'corrupt', PINS_RAW: '{ not json' }, encoding: 'utf-8',
  });
  const out = JSON.parse(r.stdout.split('@@RESULT@@').pop());
  assert.equal(out.count, 0);
  assert.equal(out.code, -32012);
  assert.match(out.error, /unreadable/);
});
