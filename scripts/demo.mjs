#!/usr/bin/env node
// Start an isolated, loopback-only demo. Never reads the operator's gateway env.
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(a => a !== '--check')) throw new Error('Usage: node scripts/demo.mjs [--check]');
await access(path.join(root, 'build/sse.js')).catch(() => { throw new Error('Build first: npm run build'); });
const data = await mkdtemp(path.join(tmpdir(), 'patchbay-demo-'));
const config = path.join(data, 'config');
await mkdir(config);
const save = (file, value) => writeFile(path.join(config, file), JSON.stringify(value, null, 2), { mode: 0o600 });
const secret = () => randomBytes(24).toString('base64url');
const flatToken = secret(), collapsedToken = secret(), password = secret();
const createdAt = new Date().toISOString();
const hosts = ['demo-web', 'demo-db', 'demo-cache'];
await save('mcp_server.json', { mcpServers: Object.fromEntries(hosts.map(host => [host, {
  type: 'stdio', command: process.execPath, args: [path.join(root, 'examples/demo/backend.mjs'), host],
}])) });
await save('users.json', [
  { username: 'demo-flat', token: flatToken, createdAt, collapseTools: false },
  { username: 'demo-collapsed', token: collapsedToken, createdAt, collapseTools: true },
]);
// Explicit kind enables collapsing these fake SSH-shaped tools. It does not
// connect SSH or alter production classification defaults.
await save('tool_policy.json', { default: { allow: ['*'] }, trifecta: {
  backendKinds: Object.fromEntries(hosts.map(host => [host, 'ssh-mcp'])),
} });
const socket = net.createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const url = `http://127.0.0.1:${port}`;
// Allowlist OS runtime variables; omit inherited gateway tokens, paths and flags.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
Object.assign(env, {
  PORT: String(port), BIND_HOST: '127.0.0.1', ENABLE_ADMIN_UI: 'true',
  ADMIN_USERNAME: 'demo', ADMIN_PASSWORD: password, SESSION_SECRET: secret(),
  PATCHBAY_CONFIG_DIR: config, MCP_AUDIT_DIR: path.join(data, 'audit'), TOOLS_FOLDER: path.join(data, 'tools'),
  PATCHBAY_ENABLE_TERMINAL: 'false', PATCHBAY_ENABLE_INSTALL_RUNNER: 'false', PATCHBAY_ENABLE_DEPLOY_KEYS: 'false',
  GATEWAY_CLIENT_NAME: 'Simulated demo', MCP_PIN_TOOLS: 'true',
});
const child = spawn(process.execPath, ['examples/demo/gateway.mjs'], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
let spawnError;
child.on('error', error => { spawnError = error; });
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  if (child.exitCode === null) {
    if (child.connected) child.send('stop');
    let timer;
    await Promise.race([once(child, 'exit').catch(() => {}), new Promise(resolve => {
      timer = setTimeout(() => { child.kill(); resolve(); }, 12000);
    })]);
    clearTimeout(timer);
  }
  // Only remove the unique directory created above, beneath the OS temp folder.
  if (path.dirname(data) !== path.resolve(tmpdir()) || !path.basename(data).startsWith('patchbay-demo-')) {
    throw new Error('Refusing to clean an unexpected demo directory');
  }
  await rm(data, { recursive: true, force: true });
}
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
async function connect(token) {
  const client = new Client({ name: 'patchbay-demo-check', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}
try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Demo gateway exited (${child.exitCode})`);
    try {
      const r = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok && (await r.json()).ready) { ready = true; break; }
    } catch { /* Startup can take a moment. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Demo did not become ready within 30 seconds');
  const clients = [];
  try {
    const flat = await connect(flatToken); clients.push(flat);
    const collapsed = await connect(collapsedToken); clients.push(collapsed);
    assert.equal((await flat.listTools()).tools.length, 6);
    assert.equal((await collapsed.listTools()).tools.length, 2);
    const result = await collapsed.callTool({ name: 'ssh__read-command', arguments: { host: 'demo-web', command: 'uptime' } });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /SIMULATED demo-web: healthy/);
    const denied = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
    console.log('Demo check passed: three backends, six tools collapsed to two, authenticated routing, anonymous request rejected.');
  } finally { await Promise.all(clients.map(client => client.close())); }
  if (!check) {
    console.log(`\nSimulated servers only. No SSH or real service changes.\nAdmin: ${url}/admin\nLogin: demo / ${password}\nClient endpoint: ${url}/mcp\nBearer token (collapsed demo user): ${collapsedToken}\nTemporary data: ${data}\nCtrl+C stops the demo and removes its temporary data.`);
    await once(child, 'exit');
  }
} catch (error) {
  // Do not print raw gateway logs: they can contain generated demo credentials.
  console.error(error.message);
  process.exitCode = 1;
} finally { await stop(); }
