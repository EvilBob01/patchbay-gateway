// GET /readyz on the real gateway process (build/sse.js): ready only while
// every required backend is up; unauthenticated callers get counts only, never
// a backend name; an admin session also gets the names of backends not up;
// /healthz stays liveness-only. Bound to 127.0.0.1 only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(here, '..', 'build');
const FIXTURE = path.join(here, 'fixtures', 'fake-backend.mjs');
const PASSWORD = 'a-real-test-password';

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startGateway(env, mcpServers) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readyz-'));
  mkdirSync(path.join(dir, 'config'));
  const block = path.join(dir, 'never.block');
  writeFileSync(block, ''); // backends with --fail-if=<block> never connect
  const fake = (name, ...flags) => ({ type: 'stdio', command: process.execPath, args: [FIXTURE, ...flags, `--name=${name}`] });
  const servers = Object.fromEntries(Object.entries(mcpServers).map(([k, v]) => [k, { ...fake(k, ...(v.down ? [`--fail-if=${block}`] : [])), ...(v.required !== undefined ? { required: v.required } : {}) }]));
  writeFileSync(path.join(dir, 'config', 'mcp_server.json'), JSON.stringify({ mcpServers: servers }));
  const port = await freePort();
  const childEnv = { ...process.env };
  for (const k of ['ENABLE_ADMIN_UI', 'ADMIN_PASSWORD', 'ADMIN_USERNAME', 'ALLOWED_TOKENS', 'ALLOWED_KEYS', 'PATCHBAY_CONFIG_DIR']) delete childEnv[k];
  Object.assign(childEnv, {
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    SESSION_SECRET: 'test-session-secret-not-used-elsewhere',
    TOOLS_FOLDER: path.join(dir, 'tools'),
    MCP_AUDIT_DIR: path.join(dir, 'audit'),
    MCP_USERS_PATH: path.join(dir, 'config', 'users.json'),
    MCP_TOOL_POLICY_PATH: path.join(dir, 'config', 'tool_policy.json'),
    MCP_TOOL_PINS_PATH: path.join(dir, 'config', 'tool_pins.json'),
    MCP_BACKEND_RECONNECT_BASE_MS: '60000',
    LOGGING: 'info',
    ...env,
  });
  const child = spawn(process.execPath, [path.join(BUILD, 'sse.js')], { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  await new Promise((resolve, reject) => {
    // On failure the caller never gets stop(), so kill the child here: a leaked
    // gateway keeps this test process alive and hangs the whole run.
    const timer = setTimeout(() => { child.kill(); reject(new Error(`gateway did not start within 60 s:\n${output}`)); }, 60_000);
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
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json, headers: res.headers };
  };
  const login = () => request('POST', '/admin/login', { username: 'admin', password: PASSWORD });
  async function stop() {
    child.kill(); // this child only, by its own handle
    await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
  return { request, login, stop };
}

const NAMES = ['alphaup', 'bravodown', 'charlieopt'];

test('a required backend down: 503, counts only without auth, names with an admin session', async (t) => {
  const gw = await startGateway({ ENABLE_ADMIN_UI: 'true', ADMIN_PASSWORD: PASSWORD }, {
    alphaup: {}, bravodown: { down: true }, charlieopt: { down: true, required: false },
  });
  t.after(gw.stop);

  const anon = await gw.request('GET', '/readyz');
  assert.equal(anon.status, 503, anon.text);
  assert.equal(anon.headers.get('cache-control'), 'no-store');
  assert.deepEqual(anon.json, { ready: false, initialized: true, required: { up: 1, total: 2 }, optional: { up: 0, total: 1 } });
  for (const n of NAMES) assert.ok(!anon.text.includes(n), `unauthenticated /readyz must not name ${n}`);
  assert.equal(anon.headers.get('set-cookie'), null, 'no session is created for an anonymous probe');

  const health = await gw.request('GET', '/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { status: 'ok' }, '/healthz stays liveness-only');

  assert.equal((await gw.login()).status, 200);
  const admin = await gw.request('GET', '/readyz');
  assert.equal(admin.status, 503);
  assert.deepEqual(admin.json.notUp.map(n => [n.backend, n.required]).sort(), [['bravodown', true], ['charlieopt', false]]);
  assert.ok(!admin.text.includes('lastError'), 'never the last error, even for an admin');
});

// Two gateway processes in all: this file runs alongside the rest of the suite,
// and the installer's timing tests are sensitive to load.
test('admin UI off, only an optional backend down: still served, 200 ready, counts only', async (t) => {
  const gw = await startGateway({}, { alphaup: {}, charlieopt: { down: true, required: false } });
  t.after(gw.stop);
  const r = await gw.request('GET', '/readyz');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ready: true, initialized: true, required: { up: 1, total: 1 }, optional: { up: 0, total: 1 } }, r.text);
  for (const n of NAMES) assert.ok(!r.text.includes(n));
});
