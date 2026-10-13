// End-to-end tests for tool collapsing through the gateway's real tools/list
// and tools/call handlers (src/mcp-proxy.ts), against fake stdio backends
// (test/fixtures/fake-backend.mjs). Proves that a collapsed call is decided,
// classified, audited and shaped as a call to the real backend tool.
//
// Run from the fork root after a build:  node --test test/collapse-gateway.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'fake-backend.mjs');
const BUILD = path.join(here, '..', 'build');

// mcp-proxy.ts reads config/ from the working directory; policy and audit
// paths are read from the environment at import time.
const dir = mkdtempSync(path.join(tmpdir(), 'collapse-gw-'));
mkdirSync(path.join(dir, 'config'));
const AUDIT_DIR = path.join(dir, 'audit');
process.env.MCP_TOOL_POLICY_PATH = path.join(dir, 'config', 'tool_policy.json');
process.env.MCP_AUDIT_DIR = AUDIT_DIR;
process.env.MCP_USERS_PATH = path.join(dir, 'config', 'users.json');
process.env.LOGGING = 'error';
delete process.env.MCP_COLLAPSE_TOOLS;
delete process.env.MCP_MERGE_TEXT_CONTENT;
delete process.env.MCP_AUDIT_DISABLE;

const backend = (name, ...flags) => ({ type: 'stdio', command: process.execPath, args: [FIXTURE, ...flags, `--name=${name}`] });
const servers = {
  web01: backend('web01', 'ssh-mcp'),
  db01: backend('db01', 'ssh-mcp'),
  app01: backend('app01', 'ssh-mcp', '--drift', '--extra'),
  misc: backend('misc'), // unknown kind: never collapsed
};
writeFileSync(path.join(dir, 'config', 'mcp_server.json'), JSON.stringify({ mcpServers: servers }));
writeFileSync(process.env.MCP_TOOL_POLICY_PATH, JSON.stringify({
  default: { allow: ['*'] },
  static: { allow: ['*'] },
  users: { alice: { allow: ['web01/*'] } },
  trifecta: { classify: { 'db01/read-command': { untrustedContent: true } } },
}));

process.chdir(dir);
const P = await import(pathToFileURL(path.join(BUILD, 'mcp-proxy.js')).href);
const { cleanup, createServerInstance } = await P.createServer();

test.after(async () => {
  await cleanup();
  process.chdir(here);
  rmSync(dir, { recursive: true, force: true });
});

const who = (username, extra = {}) => ({ kind: 'user', username, source: 'users.json', ...extra });
const ALICE = who('alice', { collapseTools: true });            // policy: web01 only
const CAROL = who('carol', { collapseTools: true });            // everything
const MERGER = who('merger', { collapseTools: true, mergeTextContent: true });
const PLAIN = who('plain');                                     // collapsing off (gateway default)

class MockTransport {
  constructor(sessionId) { this.sessionId = sessionId; this.waiting = new Map(); }
  async start() {}
  async close() { this.onclose?.(); }
  async send(msg) { const w = this.waiting.get(msg.id); if (w) { this.waiting.delete(msg.id); w(msg); } }
}
let nextSession = 0, nextId = 0;
async function session(identity) {
  const t = new MockTransport(`sess-${++nextSession}`);
  P.setSessionIdentity(t.sessionId, identity);
  await createServerInstance().connect(t);
  const rpc = (method, params) => new Promise(resolve => {
    const id = ++nextId;
    t.waiting.set(id, resolve);
    t.onmessage({ jsonrpc: '2.0', id, method, params });
  });
  return {
    sessionId: t.sessionId,
    list: async () => (await rpc('tools/list', {})).result.tools,
    call: (name, args) => rpc('tools/call', { name, arguments: args }),
  };
}
const echoed = (res) => JSON.parse(res.result.content[0].text);
const byName = (tools) => Object.fromEntries(tools.map(t => [t.name, t]));

async function auditLines() {
  await new Promise(r => setTimeout(r, 150)); // writes are fire-and-forget
  if (!existsSync(AUDIT_DIR)) return [];
  const file = path.join(AUDIT_DIR, `tools-call-${new Date().toISOString().slice(0, 10)}.jsonl`);
  return existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l)) : [];
}
const lastAuditFor = async (sessionId) => (await auditLines()).filter(l => l.sessionId === sessionId).at(-1);

test('collapsing off: every backend tool is listed per host, exactly as the backend defines it', async () => {
  const tools = await (await session(PLAIN)).list();
  assert.deepEqual(tools.map(t => t.name), [
    'app01__read-command', 'app01__run-command', 'app01__tail-log',
    'db01__read-command', 'db01__run-command',
    'misc__read-command', 'misc__run-command',
    'web01__read-command', 'web01__run-command',
  ]);
  const t = byName(tools)['db01__run-command'];
  assert.equal(t.description, 'Run a shell command on the remote server.');
  assert.equal(t.inputSchema.properties.host, undefined);
  const s = await session(PLAIN);
  assert.equal((await s.call('ssh__run-command', { host: 'web01', command: 'x' })).error.code, -32601, 'collapsed names do not exist when off');
});

test('collapsing on: identical ssh tools are listed once with a host enum; the rest stay per host', async () => {
  const tools = await (await session(CAROL)).list();
  assert.deepEqual(tools.map(t => t.name), [
    'app01__read-command', 'app01__tail-log',
    'misc__read-command', 'misc__run-command',
    'ssh__read-command', 'ssh__run-command',
  ]);
  const t = byName(tools);
  assert.deepEqual(t['ssh__run-command'].inputSchema.properties.host.enum, ['app01', 'db01', 'web01']);
  assert.deepEqual(t['ssh__read-command'].inputSchema.properties.host.enum, ['db01', 'web01'], 'drifted app01 is not a member');
  assert.deepEqual(t['ssh__run-command'].inputSchema.required, ['host', 'command']);
  assert.match(t['ssh__run-command'].description, /several hosts/);
});

test('the host enum is filtered by tool policy per caller', async () => {
  const tools = byName(await (await session(ALICE)).list());
  assert.deepEqual(Object.keys(tools).sort(), ['ssh__read-command', 'ssh__run-command']);
  assert.deepEqual(tools['ssh__run-command'].inputSchema.properties.host.enum, ['web01']);
  assert.deepEqual(tools['ssh__read-command'].inputSchema.properties.host.enum, ['web01']);
});

test('a collapsed call reaches the real backend tool, without the host argument', async () => {
  const s = await session(CAROL);
  const res = await s.call('ssh__run-command', { host: 'db01', command: 'uptime' });
  assert.deepEqual(echoed(res), { backend: 'db01', tool: 'run-command', args: { command: 'uptime' } });
  const line = await lastAuditFor(s.sessionId);
  assert.equal(line.tool, 'ssh__run-command');
  assert.equal(line.toolKey, 'db01__run-command');
  assert.equal(line.backend, 'db01');
  assert.equal(line.ok, true);
  assert.equal(line.user, 'carol');
});

test('a denied host stays denied (authz on the real backend/tool), and is audited as such', async () => {
  const s = await session(ALICE);
  assert.equal(echoed(await s.call('ssh__run-command', { host: 'web01', command: 'id' })).backend, 'web01');
  const res = await s.call('ssh__run-command', { host: 'db01', command: 'id' });
  assert.equal(res.error.code, -32003);
  const line = await lastAuditFor(s.sessionId);
  assert.equal(line.decision, 'deny');
  assert.equal(line.toolKey, 'db01__run-command');
  assert.equal(line.backend, 'db01');
  assert.equal(line.ok, false);
  // The old per-host name is just as denied.
  assert.equal((await s.call('db01__run-command', { command: 'id' })).error.code, -32003);
});

test('a missing or unknown host is invalid params, naming only the hosts the caller may use', async () => {
  const s = await session(ALICE);
  for (const args of [{ command: 'id' }, { host: 'nope', command: 'id' }]) {
    const res = await s.call('ssh__run-command', args);
    assert.equal(res.error.code, -32602);
    assert.match(res.error.message, /one of: web01\.$/);
    assert.doesNotMatch(res.error.message, /db01|app01/);
  }
  // app01 is in the group for run-command but not for read-command (drifted).
  const c = await session(CAROL);
  assert.equal((await c.call('ssh__read-command', { host: 'app01', command: 'ls' })).error.code, -32602);
});

test('trifecta axes come from the real backend behind the collapsed name', async () => {
  // db01/read-command is classified untrustedContent; web01's is not.
  const s = await session(CAROL);
  assert.ok((await s.call('ssh__run-command', { host: 'web01', command: 'x' })).result, 'private + external');
  assert.ok((await s.call('ssh__read-command', { host: 'web01', command: 'x' })).result, 'web01 read adds nothing');
  const res = await s.call('ssh__read-command', { host: 'db01', command: 'x' });
  assert.equal(res.error.code, -32010, 'db01 read completes the trifecta');
  const line = await lastAuditFor(s.sessionId);
  assert.equal(line.backend, 'db01');
  assert.equal(line.toolKey, 'db01__read-command');
  assert.deepEqual(line.trifecta.completing, ['untrustedContent']);
  assert.ok(line.trifecta.toolAxes.includes('untrustedContent'));
  assert.equal(line.trifecta.sources.externalComm, 'web01__run-command', 'session state is keyed on the real tool');
});

test('old per-host names stay callable (unlisted) with collapsing on', async () => {
  const s = await session(CAROL);
  assert.deepEqual(echoed(await s.call('web01__run-command', { command: 'id' })), { backend: 'web01', tool: 'run-command', args: { command: 'id' } });
  const line = await lastAuditFor(s.sessionId);
  assert.equal(line.tool, 'web01__run-command');
  assert.equal(line.toolKey, 'web01__run-command');
});

test('text-merge shaping applies to collapsed calls as to any other', async () => {
  const merged = await (await session(MERGER)).call('ssh__run-command', { host: 'web01', command: 'x' });
  assert.equal(merged.result.content.length, 1);
  const plain = await (await session(CAROL)).call('ssh__run-command', { host: 'web01', command: 'x' });
  assert.equal(plain.result.content.length, 2);
});

test('live reload: an added backend joins the group, a removed one leaves it', async () => {
  await P.updateBackendConnections({ mcpServers: { ...servers, ops01: backend('ops01', 'ssh-mcp') } }, { tools: {} });
  let t = byName(await (await session(CAROL)).list());
  assert.deepEqual(t['ssh__run-command'].inputSchema.properties.host.enum, ['app01', 'db01', 'ops01', 'web01']);
  const { db01, ...withoutDb } = servers;
  await P.updateBackendConnections({ mcpServers: { ...withoutDb, ops01: backend('ops01', 'ssh-mcp') } }, { tools: {} });
  t = byName(await (await session(CAROL)).list());
  assert.deepEqual(t['ssh__run-command'].inputSchema.properties.host.enum, ['app01', 'ops01', 'web01']);
  assert.deepEqual(t['ssh__read-command'].inputSchema.properties.host.enum, ['ops01', 'web01']);
  const res = await (await session(CAROL)).call('ssh__run-command', { host: 'db01', command: 'x' });
  assert.equal(res.error.code, -32602, 'removed host is no longer routable');
});

test('a tool renamed in tool_config.json drops out of its group', async () => {
  await P.updateBackendConnections({ mcpServers: servers }, { tools: { 'web01__run-command': { enabled: true, exposedName: 'web-shell' } } });
  const t = byName(await (await session(CAROL)).list());
  assert.deepEqual(t['ssh__run-command'].inputSchema.properties.host.enum, ['app01', 'db01']);
  assert.ok(t['web-shell']);
  await P.updateBackendConnections({ mcpServers: servers }, { tools: {} });
});
