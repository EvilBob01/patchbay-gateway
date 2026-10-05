// Manual, in-container verification of per-tool authorization (src/policy.ts).
// Not part of the offline suite: it needs a running gateway, the admin
// credentials and a static key, so it is run by hand on a gateway box after a
// deploy:
//
//   POLICY_TEST_SERVER=<a backend with harmless tools> node test/tool-policy.live.mjs
//
// It creates a throwaway user through the admin API, restricts it to one
// backend, checks list filtering, call enforcement, audit of the denial, scope
// isolation between concurrent sessions and live policy edits, then revokes the
// user and puts the policy file back exactly as it found it (including absent).
// Prints counts, names and status only -- never credential values.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

// Defaults: the post-rename paths, else the pre-rename ones a box still uses.
const firstExisting = (...p) => p.find(existsSync) ?? p[0];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE = process.env.MCP_BASE || 'http://localhost:3663';
const AUDIT_DIR = process.env.MCP_AUDIT_DIR || firstExisting('/var/log/patchbay-gateway/audit', '/var/log/mcp-gateway-audit');
const ENV_PATH = process.env.ENV_PATH || firstExisting('/etc/patchbay-gateway.env', '/etc/mcp-proxy-server.env');
const POLICY_PATH = process.env.POLICY_PATH || path.join(REPO, 'config', 'tool_policy.json');
const SERVER = process.env.POLICY_TEST_SERVER || 'connectors';
const SERVER2 = process.env.POLICY_TEST_SERVER2; // optional: widen to this in the live-edit step
const TEST_USER = `authz-test-${crypto.randomBytes(3).toString('hex')}`;

// --- credentials, read in-container, never printed -----------------------
const env = Object.fromEntries(readFileSync(ENV_PATH, 'utf-8').split('\n')
  .map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
  .map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]));
const staticKey = (env.ALLOWED_KEYS || '').split(',')[0].trim();
if (!staticKey) throw new Error(`no ALLOWED_KEYS value in ${ENV_PATH}`);

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// --- admin API -----------------------------------------------------------
let cookie = '';
async function admin(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function connect(label, headers) {
  const transport = new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers } });
  const client = new Client({ name: `policy-test-${label}`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}
const names = async (s) => (await s.client.listTools()).tools.map(t => t.name);
async function call(s, name) {
  try { await s.client.callTool({ name, arguments: {} }); return 'ok'; }
  catch (e) { return `err(${e?.code ?? '?'})`; }
}

function auditLinesSince(ts) {
  const out = [];
  let files = [];
  try { files = readdirSync(AUDIT_DIR).filter(f => f.startsWith('tools-call-')); } catch { return out; }
  for (const f of files) for (const raw of readFileSync(path.join(AUDIT_DIR, f), 'utf-8').split('\n')) {
    if (!raw.trim()) continue;
    try { const o = JSON.parse(raw); if (o.ts >= ts) out.push(o); } catch {}
  }
  return out;
}

const hadPolicy = existsSync(POLICY_PATH);
const originalPolicy = hadPolicy ? readFileSync(POLICY_PATH, 'utf-8') : null;
console.log(`policy file before test: ${hadPolicy ? 'present' : 'absent'}`);
const sessions = [];

try {
  check((await admin('POST', '/admin/login', { username: env.ADMIN_USERNAME || 'admin', password: env.ADMIN_PASSWORD })).status === 200, 'admin login');
  const created = await admin('POST', '/admin/users', { username: TEST_USER });
  check(created.status === 200 && created.data?.user?.token, `created throwaway user ${TEST_USER}`);
  const userTok = created.data.user.token;

  const allTools = (await admin('GET', '/admin/tools/list')).data.tools || [];
  const serverToolCount = allTools.filter(t => t.serverName === SERVER).length;
  console.log(`backend under test: ${SERVER} (${serverToolCount} tools)`);
  if (!serverToolCount) throw new Error(`backend '${SERVER}' has no tools here; set POLICY_TEST_SERVER`);

  const U = await connect('user', { Authorization: `Bearer ${userTok}` }); sessions.push(U);
  const S = await connect('static', { 'x-api-key': staticKey }); sessions.push(S);

  // 1. Baseline under whatever policy exists now (normally none): identical.
  const staticAll = await names(S);
  const userBefore = await names(U);
  console.log(`\n--- before restriction: static=${staticAll.length} user=${userBefore.length}`);
  if (!hadPolicy) check(userBefore.length === staticAll.length, 'no policy: new user sees exactly what static sees');

  // 2. Restrict the test user to one backend, through the admin API. Both
  //    sessions are already open -- this is also the no-restart check.
  const base = hadPolicy ? JSON.parse(originalPolicy) : {};
  const restricted = { ...base, users: { ...(base.users || {}), [TEST_USER]: { allow: [`${SERVER}/*`] } } };
  const saved = await admin('POST', '/admin/tool-policy', restricted);
  check(saved.status === 200, 'policy saved via admin API');
  check((await admin('POST', '/admin/tool-policy', { users: { x: { allow: ['bare-name'] } } })).status === 400, 'admin API rejects an invalid policy');

  const userList = await names(U);
  const staticList = await names(S);
  console.log(`\n--- after restriction (same open sessions): static=${staticList.length} user=${userList.length}`);
  check(userList.length === serverToolCount, `user list shows only ${SERVER}'s ${serverToolCount} tools`);
  check(userList.every(n => staticAll.includes(n)), 'every tool the user sees is a real tool');
  check(staticList.length === staticAll.length, 'static list unchanged');

  const allowedTool = userList.find(n => /list_available_connectors|list-connections|list/.test(n)) || userList[0];
  const hiddenTool = staticAll.find(n => !userList.includes(n));
  console.log(`allowed tool: ${allowedTool}   hidden tool: ${hiddenTool}`);

  const t0 = new Date().toISOString();
  const deniedCall = await call(U, hiddenTool);
  check(deniedCall === 'err(-32003)', `user calling hidden tool by name is rejected: ${deniedCall}`);
  check(await call(U, allowedTool) === 'ok', 'user can call a tool on its own backend');
  check(await call(S, allowedTool) === 'ok', 'static can still call it too');

  // 3. Concurrency: interleave both sessions; scopes must not bleed.
  console.log('\n--- concurrent, interleaved ---');
  const results = await Promise.all([
    names(U), names(S), call(U, hiddenTool), names(U), call(S, allowedTool), names(S),
    call(U, allowedTool), names(U), names(S), call(U, hiddenTool),
  ]);
  const [l1, l2, c1, l3, c2, l4, c3, l5, l6, c4] = results;
  check([l1, l3, l5].every(l => l.length === serverToolCount), 'user lists stay restricted under concurrency');
  check([l2, l4, l6].every(l => l.length === staticAll.length), 'static lists stay complete under concurrency');
  check(c1 === 'err(-32003)' && c4 === 'err(-32003)', 'user hidden-tool calls denied under concurrency');
  check(c2 === 'ok' && c3 === 'ok', 'allowed calls succeed under concurrency');

  // 4. Audit: the denial is recorded and attributed.
  await new Promise(r => setTimeout(r, 500)); // audit writes are fire-and-forget
  const lines = auditLinesSince(t0);
  const denies = lines.filter(l => l.user === TEST_USER && l.decision === 'deny');
  const allows = lines.filter(l => l.user === TEST_USER && l.decision === 'allow');
  const staticDenies = lines.filter(l => l.identityKind === 'static' && l.decision === 'deny');
  console.log(`\naudit since test start: ${lines.length} lines; ${TEST_USER}: ${denies.length} deny / ${allows.length} allow; static denies: ${staticDenies.length}`);
  if (denies[0]) console.log('sample deny:', JSON.stringify({ user: denies[0].user, identityKind: denies[0].identityKind, tool: denies[0].tool, backend: denies[0].backend, decision: denies[0].decision, authzRule: denies[0].authzRule, authzReason: denies[0].authzReason, errorCode: denies[0].errorCode, ok: denies[0].ok }));
  check(denies.length === 3, 'all 3 denied calls audited as decision=deny with the test identity');
  check(denies.every(d => d.ok === false && d.authzRule === `users.${TEST_USER}` && d.toolKey && d.backend !== SERVER), 'deny lines name the rule, tool key and backend');
  check(allows.length === 2, 'allowed calls audited as decision=allow');
  check(staticDenies.length === 0, 'no static call was denied');

  // 5. Hand-edit the file (not the API): applies on the next request.
  if (SERVER2) {
    const widened = { ...restricted, users: { ...restricted.users, [TEST_USER]: { allow: [`${SERVER}/*`, `${SERVER2}/*`] } } };
    writeFileSync(POLICY_PATH, JSON.stringify(widened, null, 2));
    const expected = serverToolCount + allTools.filter(t => t.serverName === SERVER2).length;
    const widenedList = await names(U);
    check(widenedList.length === expected, `hand edit applied without restart: user now sees ${widenedList.length} (expected ${expected})`);
  }
} catch (e) {
  failures++;
  console.log(`FAIL threw: ${e?.message || e}`);
} finally {
  for (const s of sessions) { await s.transport.terminateSession().catch(() => {}); await s.client.close().catch(() => {}); }
  // Put the policy back exactly as found.
  if (hadPolicy) writeFileSync(POLICY_PATH, originalPolicy);
  else if (existsSync(POLICY_PATH)) unlinkSync(POLICY_PATH);
  console.log(`\npolicy file restored: ${hadPolicy ? 'original content' : 'removed (was absent)'}`);
  const revoked = await admin('DELETE', `/admin/users/${encodeURIComponent(TEST_USER)}`);
  console.log(`throwaway user revoked: ${revoked.status === 200}`);
  if (revoked.status !== 200) failures++;
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
