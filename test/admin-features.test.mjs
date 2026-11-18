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
    // The admin API reads and writes here too, never in the repo's own config/.
    PATCHBAY_CONFIG_DIR: path.join(dir, 'config'),
    LOGGING: 'info',
    ...env,
  });
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];

  const child = spawn(process.execPath, [path.join(BUILD, 'sse.js')], { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  await new Promise((resolve, reject) => {
    // On failure the caller never gets a stop handle, so kill the child here: a
    // leaked gateway keeps this test process alive and hangs the whole run.
    const timer = setTimeout(() => { child.kill(); reject(new Error(`gateway did not start within 60 s:\n${output}`)); }, 60_000);
    const check = () => { if (output.includes('Patchbay Gateway is running')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', check);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`gateway exited (${code}):\n${output}`)); });
  });

  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const request = async (method, url, body, extraHeaders = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers };
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
      if (env.ENABLE_ADMIN_UI === 'true' && env.ADMIN_PASSWORD) {
        const info = await gw.request('GET', '/admin/info');
        assert.equal(info.status, 200);
        assert.deepEqual(Object.keys(info.json).sort(), ['color', 'name'], 'no version before login');
        const anon = await gw.request('GET', '/admin/version');
        assert.notEqual(anon.status, 200, 'version needs login');
        assert.equal(anon.json?.version, undefined);
        assert.equal((await gw.login()).status, 200);
        const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf-8'));
        const authed = await gw.request('GET', '/admin/version');
        assert.equal(authed.status, 200);
        assert.deepEqual(authed.json, { version: pkg.version });
      }
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

// --- Stale-save protection (src/fileRevision.ts) ---
// The admin UI saves a whole file from the copy it loaded. A page loaded before
// a hand edit or another admin's save must not undo that change: a production
// gateway lost a backend version pin to a Save from a page loaded an hour earlier.
const REV = 'x-config-revision';

test('server config: a save from a copy older than the file is refused (409) and the file is untouched', async (t) => {
  const gw = await startGateway({ ENABLE_ADMIN_UI: 'true', ADMIN_PASSWORD: PASSWORD });
  t.after(gw.stop);
  assert.equal((await gw.login()).status, 200);
  const file = path.join(gw.dir, 'config', 'mcp_server.json');

  const loaded = await gw.request('GET', '/admin/config');
  assert.equal(loaded.status, 200, JSON.stringify(loaded.json));
  const rev1 = loaded.headers.get(REV);
  assert.match(rev1, /^[0-9a-f]{32}$/);

  // Someone pins a version on the gateway after the page loaded.
  const pinned = { mcpServers: { box: { type: 'stdio', command: 'npx', args: ['ssh-mcp@2.22.1', '-y', '--'] } } };
  writeFileSync(file, JSON.stringify(pinned, null, 2));

  // The old page saves its unpinned copy: refused, and the pin survives.
  const stale = { mcpServers: { box: { type: 'stdio', command: 'npx', args: ['ssh-mcp', '-y', '--'] } } };
  const refused = await gw.request('POST', '/admin/config', stale, { [REV]: rev1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'STALE_REVISION');
  assert.match(refused.json.error, /Reload the page/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), pinned);
  assert.match(gw.output(), /Refused a stale save of .*mcp_server\.json/);

  // Reloaded, the page saves fine, and the revision it gets back keeps working.
  const rev2 = (await gw.request('GET', '/admin/config')).headers.get(REV);
  assert.notEqual(rev2, rev1);
  const edited = { mcpServers: { box: { ...pinned.mcpServers.box, active: false } } };
  const ok = await gw.request('POST', '/admin/config', edited, { [REV]: rev2 });
  assert.equal(ok.status, 200);
  const rev3 = ok.headers.get(REV);
  assert.equal(rev3, (await gw.request('GET', '/admin/config')).headers.get(REV), 'the save returns the new file revision');
  assert.equal((await gw.request('POST', '/admin/config', edited, { [REV]: rev3 })).status, 200);
  assert.equal((await gw.request('POST', '/admin/config', edited, { [REV]: rev2 })).status, 409, 'an older revision stays refused');

  // A client that sends no revision (a script) is not checked.
  assert.equal((await gw.request('POST', '/admin/config', edited)).status, 200);
});

test('tool config and tool policy: stale saves are refused (409), a missing file has revision "none"', async (t) => {
  const gw = await startGateway({ ENABLE_ADMIN_UI: 'true', ADMIN_PASSWORD: PASSWORD });
  t.after(gw.stop);
  assert.equal((await gw.login()).status, 200);

  for (const [url, body] of [
    ['/admin/tools/config', { tools: { 'box__run': { enabled: false } } }],
    ['/admin/tool-policy', { users: { alice: { allow: ['box/*'] } } }],
  ]) {
    const first = await gw.request('GET', url);
    assert.equal(first.status, 200, url);
    assert.equal(first.headers.get(REV), 'none', `${url}: no file yet`);
    const saved = await gw.request('POST', url, body, { [REV]: 'none' });
    assert.equal(saved.status, 200, url);
    const rev = saved.headers.get(REV);
    assert.equal(rev, (await gw.request('GET', url)).headers.get(REV), `${url}: the save returns the new revision`);
    // A second page that also loaded before the first save:
    const refused = await gw.request('POST', url, body, { [REV]: 'none' });
    assert.equal(refused.status, 409, `${url}: stale`);
    assert.equal(refused.json.code, 'STALE_REVISION');
    assert.equal((await gw.request('POST', url, body, { [REV]: rev })).status, 200, `${url}: current revision`);
  }
});
