// End-to-end tests for per-backend lazy tool loading and the gateway
// meta-tools (src/lazy.ts) through the gateway's real tools/list and
// tools/call handlers, against fake stdio backends. Proves that the meta-tools
// reveal only what the caller may use, and that a call through call_read /
// call_write is authorized, classified, rate-limited, audited and shaped as a
// call to the real backend tool.
//
// Run from the fork root after a build:  node --test test/lazy.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway, fakeBackend, who, byName, echoed } from './fixtures/gateway.mjs';

// Slow refill, so the rate-limit test can count tokens exactly.
process.env.MCP_RATE_LIMIT_TOOL_CALL_PER_MINUTE = '1';
process.env.MCP_RATE_LIMIT_TOOL_CALL_BURST = '1000';

const lazy = (conf, description) => ({ ...conf, lazy: true, ...(description ? { description } : {}) });
const servers = {
  web01: fakeBackend('web01', 'ssh-mcp'),
  db01: fakeBackend('db01', 'ssh-mcp'),
  // Same kind as web01/db01, so it would collapse with them if it weren't lazy.
  // --annotated: read-command carries readOnlyHint, status an outputSchema.
  pve: lazy(fakeBackend('pve', 'ssh-mcp', '--extra', '--annotated'), 'Hypervisor management'),
  vault: lazy(fakeBackend('vault', '--clash')),
};
const gw = await startGateway({
  prefix: 'lazy-',
  servers,
  policy: {
    default: { allow: ['*'] },
    static: { allow: ['*'] },
    users: {
      alice: { allow: ['web01/*', 'pve/read-command', 'pve/status'] },
      nolazy: { allow: ['web01/*'] },
    },
    trifecta: { classify: { 'pve/read-command': { untrustedContent: true } } },
    // pve: read-command is read by its own hint, status by this rule; vault: all
    // read except run-command, where the write rule wins.
    toolClass: { read: ['pve/status', 'vault/*'], write: ['vault/run-command'] },
  },
});
test.after(() => gw.stop());
const { P } = gw;

const ALICE = who('alice');                             // web01/*, pve read-command + status, nothing on vault
const CAROL = who('carol');                             // everything
const NOLAZY = who('nolazy');                           // web01 only: nothing lazy
const COLLAPSER = who('collapser', { collapseTools: true });
const GATEWAY = ['patchbay__call_read', 'patchbay__call_write', 'patchbay__describe_tool', 'patchbay__search_tools'];
const names = (tools) => tools.map(t => t.name);
const lastAudit = async (s) => (await gw.auditFor(s.sessionId)).at(-1);
const text = (res) => res.result.content[0].text;
const search = async (s, args) => JSON.parse(text(await s.call('patchbay__search_tools', args)));

test('a lazy backend is listed as its activate tool, plus the four gateway meta-tools once', async () => {
  const tools = await (await gw.session(CAROL)).list();
  assert.deepEqual(names(tools), [
    'db01__read-command', 'db01__run-command',
    ...GATEWAY,
    'pve__activate', 'vault__activate',
    'web01__read-command', 'web01__run-command',
  ]);
  const t = byName(tools);
  assert.match(t['pve__activate'].description, /^\[pve\] Hypervisor management\. 4 tools available/);
  assert.match(t['vault__activate'].description, /^\[vault\] Tools from the "vault" backend. 3 tools available/);
  assert.match(t['patchbay__search_tools'].description, /including 7 tools on 2 backends that are not loaded yet/);
  assert.deepEqual(t['patchbay__call_read'].inputSchema.required, ['tool']);
  assert.equal(t['patchbay__call_read'].annotations.readOnlyHint, true);
  assert.equal(t['patchbay__call_write'].annotations.destructiveHint, true);
});

test('call_* declare "arguments" as an explicitly open object (grammar-constrained clients)', async () => {
  const t = byName(await (await gw.session(CAROL)).list());
  for (const name of ['patchbay__call_read', 'patchbay__call_write']) {
    const a = t[name].inputSchema.properties.arguments;
    assert.equal(a.type, 'object', name);
    assert.equal(a.additionalProperties, true, `${name}: an object with no properties must say it is open`);
  }
});

test('non-lazy tools are listed exactly as without any lazy backend; no gateway tools then', async () => {
  const nonLazy = (tools) => tools.filter(t => !/^(pve|vault|patchbay)__/.test(t.name));
  const withLazy = nonLazy(await (await gw.session(CAROL)).list());
  const plain = Object.fromEntries(Object.entries(servers).map(([k, { lazy: _l, description: _d, ...rest }]) => [k, rest]));
  await P.updateBackendConnections({ mcpServers: plain }, { tools: {} });
  try {
    const s = await gw.session(CAROL);
    const all = await s.list();
    assert.ok(all.some(t => t.name === 'pve__run-command'), 'without the flag, pve is listed normally');
    assert.ok(!all.some(t => t.name.startsWith('patchbay__')), 'no gateway meta-tools without lazy backends');
    assert.equal(JSON.stringify(nonLazy(all)), JSON.stringify(withLazy));
    assert.equal((await s.call('patchbay__search_tools', { query: 'x' })).error.code, -32601);
  } finally {
    await P.updateBackendConnections({ mcpServers: servers }, { tools: {} });
  }
  assert.ok((await (await gw.session(CAROL)).list()).some(t => t.name === 'pve__activate'), 'flag back on after reload');
});

test('the gateway declares tools.listChanged', async () => {
  const s = await gw.session(CAROL);
  const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.capabilities.tools.listChanged, true);
});

test('per caller: allowed-tool counts; a backend with nothing allowed is invisible', async () => {
  const t = byName(await (await gw.session(ALICE)).list());
  assert.deepEqual(Object.keys(t), [...GATEWAY, 'pve__activate', 'web01__read-command', 'web01__run-command']);
  assert.match(t['pve__activate'].description, /2 tools available/);
  assert.match(t['patchbay__search_tools'].description, /including 2 tools on 1 backend that/);
});

test('a caller who can reach no lazy tool gets no gateway tools, and they answer like unknown tools', async () => {
  const s = await gw.session(NOLAZY);
  assert.deepEqual(names(await s.list()), ['web01__read-command', 'web01__run-command']);
  const unknown = (await s.call('nothing__here', {})).error;
  for (const name of [...GATEWAY, 'pve__activate']) {
    const err = (await s.call(name, { query: 'x', tool: 'pve/status' })).error;
    assert.equal(err.code, unknown.code, name);
    assert.equal(err.message.replace(name, 'X'), unknown.message.replace('nothing__here', 'X'), name);
  }
});

test('search returns only allowed tools, with summary, class, score and how to use each', async () => {
  const s = await gw.session(ALICE);
  const r = await search(s, { query: 'run command', limit: 15 });
  const tools = r.hits.map(h => h.tool);
  assert.ok(tools.includes('web01/run-command'));
  assert.ok(tools.includes('pve/read-command'));
  assert.ok(!tools.includes('pve/run-command'), 'denied tool never appears');
  assert.ok(!tools.some(t => t.startsWith('db01/') || t.startsWith('vault/')));
  const rc = r.hits.find(h => h.tool === 'pve/read-command');
  assert.equal(rc.class, 'read');
  assert.equal(rc.summary, 'pve: Run a read-only command.');
  assert.match(rc.use, /^patchbay__call_read \{"tool": "pve\/read-command"\} — or pve__activate/);
  assert.equal(typeof rc.score, 'number');
  const web = r.hits.find(h => h.tool === 'web01/run-command');
  assert.equal(web.class, 'write');
  assert.equal(web.use, 'call web01__run-command directly');
  assert.ok(!('inputSchema' in web), 'no schema inline');
});

test('search: default top 5, limit capped, ties at the cutoff all returned', async () => {
  const s = await gw.session(CAROL);
  const dflt = await search(s, { query: 'command' });
  assert.ok(dflt.hits.length >= 5);
  const five = dflt.hits[4].score;
  assert.ok(dflt.hits.slice(5).every(h => h.score === five), 'beyond 5 only ties with the 5th');
  // web01 and db01 have byte-identical definitions, so they always tie.
  const one = await search(s, { query: 'shell command remote server', limit: 1 });
  const top = one.hits[0].score;
  assert.ok(one.hits.every(h => h.score === top));
  assert.ok(one.hits.length >= 2, 'the tie at k=1 is not broken silently');
  const big = await search(s, { query: 'command', limit: 999 });
  assert.ok(big.hits.length <= 25);
});

test('search with backend lists that backend; describe gives the schema; denied reads like unknown', async () => {
  const s = await gw.session(ALICE);
  const listing = await search(s, { backend: 'pve' });
  assert.deepEqual(listing.hits.map(h => h.tool), ['pve/read-command', 'pve/status']);
  const d = JSON.parse(text(await s.call('patchbay__describe_tool', { tool: 'pve/read-command' })));
  assert.equal(d.title, 'Read-only command');
  assert.deepEqual(d.inputSchema.required, ['command']);
  assert.equal(d.class, 'read');
  assert.deepEqual(d.annotations, { readOnlyHint: true, openWorldHint: false });
  const denied = (await s.call('patchbay__describe_tool', { tool: 'pve/run-command' })).error;
  const missing = (await s.call('patchbay__describe_tool', { tool: 'pve/no-such-tool' })).error;
  assert.equal(denied.code, missing.code);
  assert.equal(denied.message.replace('pve/run-command', 'X'), missing.message.replace('pve/no-such-tool', 'X'));
  const line = await lastAudit(s);
  assert.equal(line.meta, 'describe_tool');
  assert.equal(line.ok, false);
});

test('search and describe are audited as gateway meta-calls, not backend calls', async () => {
  const s = await gw.session(CAROL);
  await search(s, { query: 'status' });
  const line = await lastAudit(s);
  assert.equal(line.tool, 'patchbay__search_tools');
  assert.equal(line.meta, 'search_tools');
  assert.equal(line.backend, null);
  assert.equal(line.toolKey, null);
  assert.equal(line.decision, undefined);
});

test('activate: list_changed on the activate response stream, then the real allowed tools, first-class', async () => {
  const s = await gw.session(ALICE);
  const res = await s.call('pve__activate', {});
  assert.match(text(res), /Loaded 2 tools from pve/);
  assert.match(text(res), /- pve__read-command\n- pve__status/);
  const [n] = s.transport.notifications;
  assert.equal(n.msg.method, 'notifications/tools/list_changed');
  assert.equal(n.relatedRequestId, res.id, 'sent on the activate request, not the standalone stream');

  const t = byName(await s.list());
  assert.deepEqual(Object.keys(t), [...GATEWAY, 'pve__read-command', 'pve__status', 'web01__read-command', 'web01__run-command']);
  assert.equal(t['pve__read-command'].title, 'Read-only command');
  assert.deepEqual(t['pve__read-command'].annotations, { readOnlyHint: true, openWorldHint: false });
  assert.ok(t['pve__status'].outputSchema);
  assert.equal(echoed(await s.call('pve__read-command', { command: 'ls' })).tool, 'read-command');
  // Search now says "call it directly" for the activated backend.
  assert.equal((await search(s, { query: 'status' })).hits.find(h => h.tool === 'pve/status').use, 'call pve__status directly');

  const audit = (await gw.auditFor(s.sessionId)).find(l => l.meta === 'activate');
  assert.equal(audit.tool, 'pve__activate');
  assert.equal(audit.backend, 'pve');
  assert.equal(audit.ok, true);
});

test('activation is per session, never global', async () => {
  const a = await gw.session(CAROL);
  await a.call('pve__activate', {});
  assert.ok(byName(await a.list())['pve__run-command']);
  const b = await gw.session(CAROL);
  const t = byName(await b.list());
  assert.equal(t['pve__run-command'], undefined);
  assert.ok(t['pve__activate']);
});

test('call_read runs a read tool and is audited as the real tool, via call_read', async () => {
  const s = await gw.session(ALICE);
  const res = await s.call('patchbay__call_read', { tool: 'pve/read-command', arguments: { command: 'uptime' } });
  assert.deepEqual(echoed(res), { backend: 'pve', tool: 'read-command', args: { command: 'uptime' } });
  const line = await lastAudit(s);
  assert.equal(line.tool, 'pve__read-command');
  assert.equal(line.toolKey, 'pve__read-command');
  assert.equal(line.backend, 'pve');
  assert.equal(line.via, 'call_read');
  assert.equal(line.decision, 'allow');
  assert.equal(line.ok, true);
  assert.equal(line.user, 'alice');
});

test('read/write class: hint, policy read rule, policy write rule beats both, unknown is write', async () => {
  const s = await gw.session(CAROL);
  const cls = async (tool) => JSON.parse(text(await s.call('patchbay__describe_tool', { tool }))).class;
  assert.equal(await cls('pve/read-command'), 'read');   // readOnlyHint
  assert.equal(await cls('pve/status'), 'read');         // toolClass.read
  assert.equal(await cls('pve/run-command'), 'write');   // no hint: unknown is write
  assert.equal(await cls('vault/read-command'), 'read'); // vault/* read
  assert.equal(await cls('vault/run-command'), 'write'); // toolClass.write beats vault/*
});

test('call_read refuses a write tool and points to call_write; call_write runs it', async () => {
  const s = await gw.session(CAROL);
  const res = await s.call('patchbay__call_read', { tool: 'pve/run-command', arguments: { command: 'id' } });
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /pve\/run-command is a write tool; .*Use patchbay__call_write/);
  const line = await lastAudit(s);
  assert.equal(line.via, 'call_read');
  assert.equal(line.toolKey, 'pve__run-command');
  assert.equal(line.ok, false);
  assert.equal(echoed(await s.call('patchbay__call_write', { tool: 'pve/run-command', arguments: { command: 'id' } })).tool, 'run-command');
  assert.equal((await lastAudit(s)).via, 'call_write');
  // call_write also runs read tools.
  assert.equal(echoed(await s.call('patchbay__call_write', { tool: 'pve/status' })).tool, 'status');
});

test('call_read/call_write on a denied tool are refused exactly like the direct call', async () => {
  const s = await gw.session(ALICE);
  const direct = (await s.call('pve__run-command', { command: 'id' })).error;
  assert.equal(direct.code, -32003);
  for (const meta of ['patchbay__call_read', 'patchbay__call_write']) {
    const viaMeta = (await s.call(meta, { tool: 'pve/run-command', arguments: { command: 'id' } })).error;
    assert.deepEqual(viaMeta, direct, `${meta}: no class hint, just the denial`);
    const line = await lastAudit(s);
    assert.equal(line.decision, 'deny');
    assert.equal(line.toolKey, 'pve__run-command');
  }
});

test('call on an unknown tool is refused exactly like the direct call', async () => {
  const s = await gw.session(CAROL);
  const direct = (await s.call('pve__no-such-tool', {})).error;
  assert.equal(direct.code, -32601);
  assert.deepEqual((await s.call('patchbay__call_write', { tool: 'pve/no-such-tool' })).error, direct);
  assert.deepEqual((await s.call('patchbay__call_read', { tool: 'pve/no-such-tool' })).error, direct);
});

test('call_* validate their own arguments', async () => {
  const s = await gw.session(CAROL);
  assert.equal((await s.call('patchbay__call_write', {})).error.code, -32602);
  assert.equal((await s.call('patchbay__call_write', { tool: 'pve/status', arguments: 'nope' })).error.code, -32602);
  assert.equal((await s.call('patchbay__call_write', { tool: 'pve/status', arguments: [1] })).error.code, -32602);
});

test('trifecta classifies and records the real tool behind call_read', async () => {
  // web01 run-command: private + external. pve read-command is classified
  // untrustedContent, so it completes the trifecta.
  const s = await gw.session(CAROL);
  assert.ok((await s.call('web01__run-command', { command: 'x' })).result);
  const res = await s.call('patchbay__call_read', { tool: 'pve/read-command', arguments: { command: 'x' } });
  assert.equal(res.error.code, -32010);
  const line = await lastAudit(s);
  assert.equal(line.toolKey, 'pve__read-command');
  assert.equal(line.via, 'call_read');
  assert.deepEqual(line.trifecta.completing, ['untrustedContent']);
  assert.equal(line.trifecta.sources.externalComm, 'web01__run-command');
});

test('a gateway call costs one rate-limit token, like a direct call', async () => {
  const { toolCallLimiter } = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'ratelimit.js')).href);
  const s = await gw.session(who('ratey'));
  const before = toolCallLimiter.take('user:ratey').remaining;
  await s.call('patchbay__call_read', { tool: 'pve/status' });
  const afterMeta = toolCallLimiter.take('user:ratey').remaining;
  await s.call('pve__status', {});
  const afterDirect = toolCallLimiter.take('user:ratey').remaining;
  assert.equal(before - afterMeta, 2, 'the meta call plus the probe');
  assert.equal(afterMeta - afterDirect, 2, 'the direct call plus the probe');
});

test('a not-yet-activated lazy tool can still be called by its real name (policy is the boundary)', async () => {
  const s = await gw.session(CAROL);
  assert.equal(echoed(await s.call('pve__run-command', { command: 'id' })).backend, 'pve');
  const alice = await gw.session(ALICE);
  assert.equal((await alice.call('pve__run-command', { command: 'id' })).error.code, -32003);
});

test('lazy backends are excluded from collapsing; search shows a collapsed tool once', async () => {
  const s = await gw.session(COLLAPSER);
  let t = byName(await s.list());
  assert.deepEqual(t['ssh__run-command'].inputSchema.properties.host.enum, ['db01', 'web01']);
  const r = await search(s, { query: 'shell command remote server' });
  const collapsed = r.hits.filter(h => /^(web01|db01)\/run-command$/.test(h.tool));
  assert.equal(collapsed.length, 1, 'one hit for the collapsed tool');
  assert.equal(collapsed[0].use, 'call ssh__run-command directly, with "host": one of db01, web01');
  await s.call('pve__activate', {});
  t = byName(await s.list());
  assert.deepEqual(t['ssh__run-command'].inputSchema.properties.host.enum, ['db01', 'web01']);
  assert.ok(t['pve__run-command']);
});

test('a real tool named like a meta-tool stays reachable through call_*, and is never listed twice', async () => {
  const s = await gw.session(CAROL);
  // vault__activate is the meta-tool, not the real tool of that name.
  assert.match(text(await s.call('vault__activate', {})), /^Loaded 2 tools from vault/);
  const listed = names(await s.list());
  assert.equal(listed.filter(n => n === 'vault__activate').length, 0, 'clashing real tool is not listed after activation');
  assert.ok(listed.includes('vault__run-command'));
  assert.equal(echoed(await s.call('patchbay__call_read', { tool: 'vault/activate' })).tool, 'activate');
});

test('a tool ref never lands on another backend whose name extends it', async () => {
  await P.updateBackendConnections({ mcpServers: { ...servers, 'pve__x': fakeBackend('pve__x') } }, { tools: {} });
  try {
    const s = await gw.session(CAROL);
    assert.equal(echoed(await s.call('pve__x__run-command', { command: 'id' })).backend, 'pve__x', 'the other backend exists');
    assert.equal((await s.call('patchbay__call_write', { tool: 'pve/x__run-command' })).error.code, -32601);
    assert.equal(echoed(await s.call('patchbay__call_write', { tool: 'pve__x/run-command', arguments: { command: 'id' } })).backend, 'pve__x');
  } finally {
    await P.updateBackendConnections({ mcpServers: servers }, { tools: {} });
  }
});
