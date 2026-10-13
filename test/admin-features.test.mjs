// Offline tests for the opt-in admin features (src/adminFeatures.ts) and the
// no-default-password rule. The HTTP cases start the real gateway
// (build/sse.js) as a child process in a temp directory, log in, and check that
// each risky route is absent (404) when its toggle is off and served when on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(here, '..', 'build');
const F = await import(pathToFileURL(path.join(BUILD, 'adminFeatures.js')).href);

const TOGGLES = ['PATCHBAY_ENABLE_TERMINAL', 'PATCHBAY_ENABLE_INSTALL_RUNNER', 'PATCHBAY_ENABLE_DEPLOY_KEYS'];
const PASSWORD = 'a-real-test-password';

// --- Unit: parsing ---

test('toggles default off; true, 1 and yes turn them on', () => {
  assert.deepEqual(F.readAdminFeatures({}), { terminal: false, installRunner: false, deployKeys: false });
  for (const v of ['true', 'TRUE', '1', 'yes', ' Yes ']) assert.equal(F.envFlag(v), true, v);
  for (const v of [undefined, '', '0', 'false', 'no', 'on', 'enabled']) assert.equal(F.envFlag(v), false, String(v));
  assert.deepEqual(
    F.readAdminFeatures({ PATCHBAY_ENABLE_TERMINAL: 'true', PATCHBAY_ENABLE_DEPLOY_KEYS: '1' }),
    { terminal: true, installRunner: false, deployKeys: true });
});

test('the startup line names every toggle and nothing else', () => {
  assert.equal(F.describeAdminFeatures({ terminal: false, installRunner: true, deployKeys: false }),
    'terminal=off, install-runner=on, deploy-keys=off');
});

test('unset, empty and placeholder admin passwords are refused, without echoing them', () => {
  for (const v of [undefined, '', '   ', 'password', 'REPLACE_ME', 'replace_me', 'change-me', 'changeme', 'admin']) {
    const problem = F.adminPasswordProblem(v);
    assert.ok(problem, `expected a problem for ${JSON.stringify(v)}`);
    if (v && v.trim()) assert.ok(!problem.includes(v), 'the message must not contain the value');
  }
  assert.equal(F.adminPasswordProblem(PASSWORD), null);
});

// --- HTTP: a real gateway process ---

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startGateway(env, mcpServers = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'admin-features-'));
  mkdirSync(path.join(dir, 'config'));
  writeFileSync(path.join(dir, 'config', 'mcp_server.json'), JSON.stringify({ mcpServers }));
  const pubKey = path.join(dir, 'id_test.pub');
  writeFileSync(pubKey, 'ssh-ed25519 AAAATESTKEY test\n');
  const port = await freePort();
  const childEnv = { ...process.env };
  for (const k of [...TOGGLES, 'ENABLE_ADMIN_UI', 'ADMIN_PASSWORD', 'ADMIN_USERNAME', 'ALLOWED_TOKENS', 'ALLOWED_KEYS', 'PATCHBAY_CONFIG_DIR']) delete childEnv[k];
  Object.assign(childEnv, {
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    SESSION_SECRET: 'test-session-secret-not-used-elsewhere',
    SSH_PUBLIC_KEY_PATH: pubKey,
    TOOLS_FOLDER: path.join(dir, 'tools'),
    MCP_AUDIT_DIR: path.join(dir, 'audit'),
    MCP_USERS_PATH: path.join(dir, 'config', 'users.json'),
    MCP_TOOL_POLICY_PATH: path.join(dir, 'config', 'tool_policy.json'),
    MCP_TOOL_PINS_PATH: path.join(dir, 'config', 'tool_pins.json'),
    LOGGING: 'info',
    ...env,
  });
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];

  const child = spawn(process.execPath, [path.join(BUILD, 'sse.js')], { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway did not start:\n${output}`)), 20_000);
    const check = () => { if (output.includes('Patchbay Gateway is running')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', check);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`gateway exited (${code}):\n${output}`)); });
  });

  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const request = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  const login = (password = PASSWORD) => request('POST', '/admin/login', { username: 'admin', password });

  async function stop() {
    child.kill();
    await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
  return { request, login, stop, dir, base, output: () => output };
}

test('admin UI on, all three toggles unset: each risky route is 404, the rest works', async (t) => {
  const gw = await startGateway({ ENABLE_ADMIN_UI: 'true', ADMIN_PASSWORD: PASSWORD });
  t.after(gw.stop);
  assert.match(gw.output(), /Admin features: terminal=off, install-runner=off, deploy-keys=off/);
  assert.ok(!gw.output().includes(PASSWORD), 'the password must not be logged');
  assert.equal((await gw.login()).status, 200);

  const features = (await gw.request('GET', '/admin/features')).json;
  for (const [k, env] of [['terminal', 'PATCHBAY_ENABLE_TERMINAL'], ['installRunner', 'PATCHBAY_ENABLE_INSTALL_RUNNER'], ['deployKeys', 'PATCHBAY_ENABLE_DEPLOY_KEYS']]) {
    assert.equal(features[k].enabled, false, k);
    assert.equal(features[k].message, `Disabled by the administrator (set ${env}=true to enable).`);
  }
  assert.equal((await gw.request('POST', '/admin/terminal/start')).status, 404);
  assert.equal((await gw.request('GET', '/admin/terminal/list')).status, 404);
  assert.equal((await gw.request('POST', '/admin/server/install/anything', {})).status, 404);
  assert.equal((await gw.request('POST', '/admin/deploy-key', { host: 'h', username: 'u', password: 'p' })).status, 404);
  // Reading the public key stays available for a manual ssh-copy-id.
  const pub = await gw.request('GET', '/admin/deploy-key/public-key');
  assert.equal(pub.status, 200);
  assert.match(pub.json.publicKey, /^ssh-ed25519 /);
  assert.equal((await gw.request('GET', '/admin/environment')).status, 200);
});

test('admin UI on, all three toggles on: each risky route is served', async (t) => {
  const gw = await startGateway({
    ENABLE_ADMIN_UI: 'true', ADMIN_PASSWORD: PASSWORD,
    PATCHBAY_ENABLE_TERMINAL: 'true', PATCHBAY_ENABLE_INSTALL_RUNNER: 'yes', PATCHBAY_ENABLE_DEPLOY_KEYS: '1',
  });
  t.after(gw.stop);
  assert.match(gw.output(), /Admin features: terminal=on, install-runner=on, deploy-keys=on/);

  // Unauthenticated callers are still turned away.
  assert.equal((await gw.request('POST', '/admin/deploy-key', {})).status, 401);
  assert.equal((await gw.login()).status, 200);

  const features = (await gw.request('GET', '/admin/features')).json;
  assert.deepEqual([features.terminal.enabled, features.installRunner.enabled, features.deployKeys.enabled], [true, true, true]);

  // The terminal route exists. Whether a PTY starts depends on node-pty being
  // built on this machine, so accept a started session or a clear refusal.
  const term = await gw.request('POST', '/admin/terminal/start');
  assert.notEqual(term.status, 404);
  if (term.status === 200) await gw.request('DELETE', `/admin/terminal/${term.json.termId}`);
  assert.equal((await gw.request('GET', '/admin/terminal/list')).status, 200);

  const install = await gw.request('POST', '/admin/server/install/not-configured', {});
  assert.equal(install.status, 200);
  assert.equal(install.json.success, true);

  // Missing fields: validated by the handler, so the route is mounted.
  const deploy = await gw.request('POST', '/admin/deploy-key', {});
  assert.equal(deploy.status, 400);
});

for (const [label, password] of [['unset', undefined], ['empty', ''], ['the env-example placeholder', 'REPLACE_ME'], ['the old default', 'password']]) {
  test(`ADMIN_PASSWORD ${label}: the admin UI is refused, MCP still starts`, async (t) => {
    const gw = await startGateway({ ENABLE_ADMIN_UI: 'true', ADMIN_PASSWORD: password, PATCHBAY_ENABLE_TERMINAL: 'true' });
    t.after(gw.stop);
    assert.match(gw.output(), /Admin UI NOT enabled: ADMIN_PASSWORD/);
    assert.match(gw.output(), /Patchbay Gateway is running/);
    assert.doesNotMatch(gw.output(), /Admin UI available/);
    assert.equal((await gw.login(password ?? 'password')).status, 404);
    assert.equal((await gw.request('POST', '/admin/terminal/start')).status, 404);
    assert.equal((await gw.request('GET', '/admin/index.html')).status, 404);
  });
}

test('backend status and reconnect: admin-only API over HTTP', async (t) => {
  const pidfile = path.join(mkdtempSync(path.join(tmpdir(), 'admin-recover-')), 'web01.pid');
  const gw = await startGateway({ ENABLE_ADMIN_UI: 'true', ADMIN_PASSWORD: PASSWORD, MCP_BACKEND_RECONNECT_BASE_MS: '100' }, {
    web01: { type: 'stdio', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-backend.mjs'), `--pidfile=${pidfile}`, '--name=web01'] },
  });
  t.after(gw.stop);
  assert.equal((await gw.request('GET', '/admin/server/status')).status, 401);
  assert.equal((await gw.request('POST', '/admin/server/reconnect/web01')).status, 401);
  assert.equal((await gw.login()).status, 200);

  const st = (await gw.request('GET', '/admin/server/status')).json;
  assert.equal(st.backends.length, 1);
  assert.equal(st.backends[0].backend, 'web01');
  assert.equal(st.backends[0].state, 'up');
  assert.equal(st.backends[0].tools, 2);
  assert.equal(st.settings.reconnectBaseMs, 100);

  // Kill it: it is reported down, then back up on its own.
  const { readFileSync } = await import('node:fs');
  const pid = Number(readFileSync(pidfile, 'utf-8'));
  process.kill(pid);
  const end = Date.now() + 10_000;
  let seen;
  while (Date.now() < end) {
    seen = (await gw.request('GET', '/admin/server/status')).json.backends[0];
    if (seen.state === 'up' && Number(readFileSync(pidfile, 'utf-8')) !== pid) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(seen.state, 'up');
  assert.match(gw.output(), /Backend "web01" is DOWN \(stdio process exited\)/);
  assert.match(gw.output(), /Backend "web01" reconnected after 1 attempt/);

  const rc = await gw.request('POST', '/admin/server/reconnect/web01');
  assert.equal(rc.status, 200);
  assert.equal(rc.json.success, true);
  assert.equal(rc.json.status.state, 'up');
  assert.equal((await gw.request('POST', '/admin/server/reconnect/nope')).status, 404);
});

// --- /healthz: readiness that does not depend on the admin UI ---

test('/healthz answers {status:"ok"} without credentials, with the admin UI on or off', async (t) => {
  for (const env of [
    { ENABLE_ADMIN_UI: 'true', ADMIN_PASSWORD: PASSWORD },
    { ENABLE_ADMIN_UI: 'false' },
    { ENABLE_ADMIN_UI: 'true' }, // no password: admin is refused, the gateway still runs
  ]) {
    const gw = await startGateway({ ...env, ALLOWED_TOKENS: 'a-test-token' });
    try {
      const r = await gw.request('GET', '/healthz');
      assert.equal(r.status, 200, JSON.stringify(env));
      assert.deepEqual(r.json, { status: 'ok' });
      if (env.ENABLE_ADMIN_UI === 'false') assert.equal((await gw.request('GET', '/admin/info')).status, 404);
    } finally { await gw.stop(); }
  }
});

test('MCP initialize reports the package.json version', async (t) => {
  const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf-8'));
  const gw = await startGateway({ ENABLE_ADMIN_UI: 'false', ALLOWED_TOKENS: 'a-test-token' });
  t.after(gw.stop);
  const res = await fetch(gw.base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer a-test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
  });
  const text = await res.text();
  const data = JSON.parse(text.startsWith('{') ? text : text.split('\n').find(l => l.startsWith('data:')).slice(5));
  assert.equal(data.result.serverInfo.version, pkg.version);
});
