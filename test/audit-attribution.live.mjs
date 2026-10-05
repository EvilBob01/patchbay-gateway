// Manual, in-container verification of caller attribution in the tools/call
// audit trail. Not part of the offline test suite: it needs a running gateway,
// a per-user token and a static env key, so it is run by hand on a gateway box
// after a deploy.
//
//   AUDIT_TEST_USER=<username in config/users.json> //     node test/audit-attribution.live.mjs
//
// Prints status and the audit lines' identity fields only -- never credential
// values. Asserts that two concurrent sessions holding *different* credentials
// are each attributed to the right caller, which is the case a single shared
// Server instance used to get wrong.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Defaults: the post-rename paths, else the pre-rename ones a box still uses.
const firstExisting = (...p) => p.find(existsSync) ?? p[0];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const URL_MCP = process.env.MCP_URL || 'http://localhost:3663/mcp';
const AUDIT_DIR = process.env.MCP_AUDIT_DIR || firstExisting('/var/log/patchbay-gateway/audit', '/var/log/mcp-gateway-audit');
const TEST_USER = process.env.AUDIT_TEST_USER || 'audit-test-user';
const USERS_PATH = process.env.USERS_PATH || path.join(REPO, 'config', 'users.json');
const ENV_PATH = process.env.ENV_PATH || firstExisting('/etc/patchbay-gateway.env', '/etc/mcp-proxy-server.env');

// --- credentials, read in-container, never printed -----------------------
const users = JSON.parse(readFileSync(USERS_PATH, 'utf-8'));
const userTok = (users.find(u => u.username === TEST_USER) || {}).token;
const envText = readFileSync(ENV_PATH, 'utf-8');
const keyLine = envText.split('\n').find(l => l.startsWith('ALLOWED_KEYS='));
const staticKey = keyLine.slice('ALLOWED_KEYS='.length).replace(/^["']|["']$/g, '').split(',')[0].trim();
if (!userTok) throw new Error(`no per-user token for ${TEST_USER} in ${USERS_PATH}`);
if (!staticKey) throw new Error(`no ALLOWED_KEYS value in ${ENV_PATH}`);
console.log(`credentials loaded: per-user token (len ${userTok.length}), static key (len ${staticKey.length})`);

async function connect(label, headers) {
  const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), { requestInit: { headers } });
  const client = new Client({ name: `audit-test-${label}`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, label };
}

const before = new Set(auditLines().map(l => l._raw));

function auditLines() {
  let out = [];
  let files = [];
  try { files = readdirSync(AUDIT_DIR).filter(f => f.startsWith('tools-call-')); } catch { return out; }
  for (const f of files) {
    for (const raw of readFileSync(path.join(AUDIT_DIR, f), 'utf-8').split('\n')) {
      if (!raw.trim()) continue;
      try { const o = JSON.parse(raw); o._raw = raw; out.push(o); } catch {}
    }
  }
  return out;
}

const A = await connect('user', { Authorization: `Bearer ${userTok}` });
const B = await connect('static', { 'x-api-key': staticKey });
console.log(`sessions established: user=${!!A.transport.sessionId} static=${!!B.transport.sessionId}`);

// Pick a safe, local, read-only tool.
const tools = (await A.client.listTools()).tools.map(t => t.name);
const TOOL = tools.find(n => n.includes('list_available_connectors')) || tools[0];
console.log(`tool under test: ${TOOL} (of ${tools.length} tools)`);

async function call(sess, tag) {
  try {
    await sess.client.callTool({ name: TOOL, arguments: {} });
    return `${tag}:ok`;
  } catch (e) {
    return `${tag}:err(${e?.code ?? ''})`;
  }
}

console.log('\n--- sequential ---');
console.log(await call(A, 'user'));
console.log(await call(B, 'static'));

console.log('\n--- concurrent, interleaved (the case the shared-server bug broke) ---');
const results = await Promise.all([
  call(A, 'user'), call(B, 'static'), call(A, 'user'),
  call(B, 'static'), call(A, 'user'), call(B, 'static'),
]);
console.log(results.join('  '));

await new Promise(r => setTimeout(r, 1500)); // let the append chain drain

console.log('\n--- new audit lines (identity fields only) ---');
const fresh = auditLines().filter(l => !before.has(l._raw));
for (const l of fresh) {
  console.log(`user=${l.user} kind=${l.identityKind} src=${l.identitySource} session=${String(l.sessionId).slice(0, 8)} tool=${l.tool} backend=${l.backend} ok=${l.ok} ms=${l.durationMs} hasArgs=${'arguments' in l}`);
}

// --- attribution check: each session id must map to exactly one identity ---
const bySession = new Map();
for (const l of fresh) {
  if (!bySession.has(l.sessionId)) bySession.set(l.sessionId, new Set());
  bySession.get(l.sessionId).add(l.user);
}
const mixed = [...bySession.entries()].filter(([, users]) => users.size > 1);
const userCount = fresh.filter(l => l.user === TEST_USER).length;
const staticCount = fresh.filter(l => l.user === 'static').length;

console.log('\n--- RESULT ---');
console.log(`sessions seen: ${bySession.size}`);
console.log(`attributed to ${TEST_USER}: ${userCount}`);
console.log(`attributed to static: ${staticCount}`);
console.log(`lines with user=undefined/null: ${fresh.filter(l => !l.user || l.user === 'undefined').length}`);
console.log(mixed.length === 0
  ? 'ok   no session mixed two identities'
  : `FAIL session(s) mixed identities: ${JSON.stringify(mixed.map(([s, u]) => [String(s).slice(0,8), [...u]]))}`);
console.log(userCount === 4 && staticCount === 4 ? 'ok   call counts match per identity (4 each)' : `FAIL expected 4 each, got user=${userCount} static=${staticCount}`);

// --- leakage check ---
const allRaw = fresh.map(l => l._raw).join('\n');
const leaks = [];
if (allRaw.includes(userTok)) leaks.push('per-user token');
if (allRaw.includes(staticKey)) leaks.push('static key');
if (fresh.some(l => 'arguments' in l)) leaks.push('arguments');
console.log(leaks.length === 0 ? 'ok   no token/key/argument content in audit lines' : `FAIL leaked: ${leaks.join(', ')}`);

await A.client.close(); await B.client.close();
