// Shared harness for the offline gateway tests: starts the real gateway
// (build/mcp-proxy.js) in-process against fake stdio backends
// (fake-backend.mjs), and opens MCP sessions on it over an in-memory transport.
//
// One gateway per test file: mcp-proxy.ts reads config/ from the working
// directory and the policy/audit paths from the environment at import time, and
// node --test runs each file in its own process.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fake-backend.mjs');
const BUILD = path.join(here, '..', '..', 'build');

/** A stdio backend entry running the fake backend under `name`. */
export const fakeBackend = (name, ...flags) =>
  ({ type: 'stdio', command: process.execPath, args: [FIXTURE, ...flags, `--name=${name}`] });

export const who = (username, extra = {}) => ({ kind: 'user', username, source: 'users.json', ...extra });

/**
 * Start a gateway. Returns the mcp-proxy module (P), a session() opener, an
 * audit reader and stop().
 */
export async function startGateway({ servers, policy, prefix = 'gw-', env = {}, pins }) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(dir, 'config'));
  const auditDir = path.join(dir, 'audit');
  process.env.MCP_TOOL_POLICY_PATH = path.join(dir, 'config', 'tool_policy.json');
  process.env.MCP_AUDIT_DIR = auditDir;
  process.env.MCP_USERS_PATH = path.join(dir, 'config', 'users.json');
  process.env.LOGGING = 'error';
  delete process.env.MCP_COLLAPSE_TOOLS;
  delete process.env.MCP_MERGE_TEXT_CONTENT;
  delete process.env.MCP_AUDIT_DISABLE;
  process.env.MCP_TOOL_PINS_PATH = path.join(dir, 'config', 'tool_pins.json');
  delete process.env.MCP_PIN_TOOLS;
  delete process.env.MCP_PIN_NEW_BACKENDS;
  Object.assign(process.env, env);
  if (pins) writeFileSync(process.env.MCP_TOOL_PINS_PATH, JSON.stringify(pins));
  if (process.env.PINS_RAW !== undefined) writeFileSync(process.env.MCP_TOOL_PINS_PATH, process.env.PINS_RAW);
  writeFileSync(path.join(dir, 'config', 'mcp_server.json'), JSON.stringify({ mcpServers: servers }));
  if (policy) writeFileSync(process.env.MCP_TOOL_POLICY_PATH, JSON.stringify(policy));

  const cwd = process.cwd();
  process.chdir(dir);
  const P = await import(pathToFileURL(path.join(BUILD, 'mcp-proxy.js')).href);
  const { cleanup, createServerInstance } = await P.createServer();

  class MockTransport {
    constructor(sessionId) { this.sessionId = sessionId; this.waiting = new Map(); this.notifications = []; }
    async start() {}
    async close() { this.onclose?.(); }
    async send(msg, options) {
      if (msg.id === undefined) { this.notifications.push({ msg, relatedRequestId: options?.relatedRequestId }); return; }
      const w = this.waiting.get(msg.id);
      if (w) { this.waiting.delete(msg.id); w(msg); }
    }
  }

  let nextSession = 0, nextId = 0;
  async function session(identity) {
    const t = new MockTransport(`${prefix}sess-${++nextSession}`);
    P.setSessionIdentity(t.sessionId, identity);
    await createServerInstance().connect(t);
    const rpc = (method, params) => new Promise(resolve => {
      const id = ++nextId;
      t.waiting.set(id, resolve);
      t.onmessage({ jsonrpc: '2.0', id, method, params });
    });
    return {
      sessionId: t.sessionId,
      transport: t,
      rpc,
      list: async () => (await rpc('tools/list', {})).result.tools,
      call: (name, args) => rpc('tools/call', { name, arguments: args }),
    };
  }

  async function auditLines() {
    await new Promise(r => setTimeout(r, 150)); // writes are fire-and-forget
    const file = path.join(auditDir, `tools-call-${new Date().toISOString().slice(0, 10)}.jsonl`);
    return existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l)) : [];
  }
  const auditFor = async (sessionId) => (await auditLines()).filter(l => l.sessionId === sessionId);

  async function stop() {
    await cleanup();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }

  return { P, createServerInstance, session, auditLines, auditFor, stop, dir, pinsPath: process.env.MCP_TOOL_PINS_PATH };
}

export const byName = (tools) => Object.fromEntries(tools.map(t => [t.name, t]));
export const echoed = (res) => JSON.parse(res.result.content[0].text);

/** Rewrite a fake backend's --defs file (see fake-backend.mjs). */
export const writeDefs = (file, defs) => writeFileSync(file, JSON.stringify(defs));
