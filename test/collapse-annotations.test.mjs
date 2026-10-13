// Collapsed tools carry the members' title, annotations and outputSchema, and
// the read/write classifier (policy.ts classifyTool) still decides per real
// backend tool: readOnlyHint counts, a toolClass write rule beats it.
//
// Run from the fork root after a build:  node --test test/collapse-annotations.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { startGateway, fakeBackend, who, byName, echoed } from './fixtures/gateway.mjs';

const gw = await startGateway({
  prefix: 'collapse-annot-',
  servers: {
    // --annotated: read-command has a title and readOnlyHint, status an outputSchema.
    web01: fakeBackend('web01', 'ssh-mcp', '--annotated'),
    db01: fakeBackend('db01', 'ssh-mcp', '--annotated'),
    zz01: fakeBackend('zz01', 'ssh-mcp', '--annotated'),
    app01: fakeBackend('app01', 'ssh-mcp'), // no annotations: differs from the others
    // Lazy, so the gateway meta-tools (call_read, ...) are listed.
    vault: { ...fakeBackend('vault'), lazy: true },
  },
  policy: {
    default: { allow: ['*'] },
    static: { allow: ['*'] },
    // An operator who treats a host's read-command as write despite its readOnlyHint.
    toolClass: { write: ['zz01/read-command'] },
  },
});
test.after(() => gw.stop());

const CAROL = who('carol', { collapseTools: true });
const text = (res) => res.result.content[0].text;

test('a collapsed tool keeps the shared title, annotations and outputSchema', async () => {
  const t = byName(await (await gw.session(CAROL)).list());
  const rc = t['ssh__read-command'];
  assert.deepEqual(rc.inputSchema.properties.host.enum, ['db01', 'web01', 'zz01']);
  assert.equal(rc.title, 'Read-only command');
  assert.deepEqual(rc.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(t['ssh__status'].outputSchema, { type: 'object', properties: { up: { type: 'boolean' } }, required: ['up'] });
  assert.deepEqual(Object.keys(t['ssh__run-command']).sort(), ['description', 'inputSchema', 'name'], 'nothing invented');
});

test('a host whose annotations differ stays per-host, with its own (absent) hints', async () => {
  const t = byName(await (await gw.session(CAROL)).list());
  assert.ok(t['app01__read-command']);
  assert.equal(t['app01__read-command'].annotations, undefined);
  assert.deepEqual(t['ssh__run-command'].inputSchema.properties.host.enum, ['app01', 'db01', 'web01', 'zz01'], 'identical tools still collapse');
});

test('call_read runs a collapsed member by its readOnlyHint', async () => {
  const s = await gw.session(CAROL);
  const res = await s.call('patchbay__call_read', { tool: 'web01/read-command', arguments: { command: 'uptime' } });
  assert.deepEqual(echoed(res), { backend: 'web01', tool: 'read-command', args: { command: 'uptime' } });
  const cls = JSON.parse(text(await s.call('patchbay__describe_tool', { tool: 'db01/read-command' }))).class;
  assert.equal(cls, 'read');
});

test('search_tools classifies the collapsed hit as read', async () => {
  const s = await gw.session(CAROL);
  const { hits } = JSON.parse(text(await s.call('patchbay__search_tools', { query: 'read-only command' })));
  const hit = hits.find(h => /call ssh__read-command directly/.test(h.use));
  assert.ok(hit, 'collapsed read-command is one hit');
  assert.equal(hit.class, 'read');
});

test('a toolClass write rule still beats readOnlyHint on a collapsed member', async () => {
  const s = await gw.session(CAROL);
  const res = await s.call('patchbay__call_read', { tool: 'zz01/read-command', arguments: { command: 'id' } });
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /zz01\/read-command is a write tool/);
  assert.equal(JSON.parse(text(await s.call('patchbay__describe_tool', { tool: 'zz01/read-command' }))).class, 'write');
  // The listed hint is the backend's own and is never rewritten by policy.
  assert.equal(byName(await s.list())['ssh__read-command'].annotations.readOnlyHint, true);
  // Direct collapsed call to it still works: toolClass only gates call_read.
  assert.equal(echoed(await s.call('ssh__read-command', { host: 'zz01', command: 'id' })).backend, 'zz01');
});

test('classifyTool on a collapsed tool hint: read by the hint, write when a toolClass write pattern matches', async () => {
  const { compilePolicy, NO_POLICY } = await import('../build/policy.js');
  const { annotations } = byName(await (await gw.session(CAROL)).list())['ssh__read-command'];
  assert.deepEqual(NO_POLICY.classifyTool('web01', 'read-command', annotations), { toolClass: 'read', source: 'readOnlyHint' });
  const strict = compilePolicy({ default: { allow: ['*'] }, toolClass: { write: ['*/read-command', '*/sftp-download'] } });
  assert.deepEqual(strict.classifyTool('web01', 'read-command', annotations), { toolClass: 'write', source: 'toolClass.write' });
});
