// tools/list passes a backend's title, annotations and outputSchema through
// unchanged, and only when the backend declares them.
//
// Run from the fork root after a build:  node --test test/tool-annotations.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { startGateway, fakeBackend, who, byName } from './fixtures/gateway.mjs';

const gw = await startGateway({
  prefix: 'annot-',
  servers: { web01: fakeBackend('web01', '--annotated'), db01: fakeBackend('db01') },
});
test.after(() => gw.stop());

test('title, annotations and outputSchema are passed through as the backend declares them', async () => {
  const t = byName(await (await gw.session(who('carol'))).list());
  assert.equal(t['web01__read-command'].title, 'Read-only command');
  assert.deepEqual(t['web01__read-command'].annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(t['web01__status'].outputSchema, { type: 'object', properties: { up: { type: 'boolean' } }, required: ['up'] });
});

test('a tool that declares none of them gets none of them', async () => {
  const t = byName(await (await gw.session(who('carol'))).list());
  assert.deepEqual(Object.keys(t['db01__read-command']).sort(), ['description', 'inputSchema', 'name']);
  assert.deepEqual(Object.keys(t['web01__run-command']).sort(), ['description', 'inputSchema', 'name']);
});
