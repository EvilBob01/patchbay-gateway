#!/usr/bin/env node
// A stand-in MCP backend for the offline tests: a stdio server with a fixed,
// ssh-mcp-like tool set that echoes every call back as JSON.
//
//   node fake-backend.mjs [ssh-mcp] --name=<backend> [--drift] [--extra]
//
// The bare `ssh-mcp` word is ignored here; it is only there so trifecta.ts
// recognises the backend as an ssh-mcp one from its command line.
//   --drift  read-command gets a different description (a schema that drifted)
//   --extra  one more tool, tail-log, that the other backends do not have
//   --annotated  read-command carries a title and annotations, and one more
//            tool, status, declares an outputSchema
//   --clash  one more tool named activate (clashes with a lazy meta-tool name)
//   --progress  one more tool, long-task, that reports progress (when the
//            request carries a progressToken) and echoes the _meta it received
//   --pidfile=<file>  write this process's pid there on start (crash tests)
//   --crashable  one more tool, crash, that exits the process mid-call
//   --fail-if=<file>  exit at once, before speaking MCP, while <file> exists
//            (a backend that cannot be (re)connected)
//   --hang-if-pid=<file>  hang: while <file> holds this process's pid, every
//            incoming request (ping included) is swallowed unanswered, but the
//            process stays alive and connected (health-probe tests)
//   --pinglog=<file>  append a line to <file> for every ping received
//   --no-ping  answer ping with "method not found" (-32601)
//   --start-delay-ms=<n>  wait n ms before speaking MCP (a slow (re)connect)
//   --defs=<file>  patch the tool set from a JSON file, re-read on every
//            tools/list: {"<tool>": {fields to merge} | null (removes it),
//            "+<tool>": {description, inputSchema?} (adds one)}. When the file
//            changes, sends notifications/tools/list_changed.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, watchFile, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const name = (argv.find(a => a.startsWith('--name=')) || '--name=?').slice('--name='.length);
const drift = argv.includes('--drift');
const extra = argv.includes('--extra');
const annotated = argv.includes('--annotated');
const clash = argv.includes('--clash');
const progress = argv.includes('--progress');
const crashable = argv.includes('--crashable');
const argValue = (flag) => { const a = argv.find(x => x.startsWith(`${flag}=`)); return a ? a.slice(flag.length + 1) : undefined; };
const failIf = argValue('--fail-if');
if (failIf && existsSync(failIf)) process.exit(3);
const pidfile = argValue('--pidfile');
if (pidfile) writeFileSync(pidfile, String(process.pid));

const command = { type: 'object', properties: { command: { type: 'string', description: 'Shell command' }, profile: { type: 'string' } }, required: ['command'] };
const tools = [
  { name: 'run-command', description: 'Run a shell command on the remote server.', inputSchema: command },
  { name: 'read-command', description: drift ? 'Run a read-only command (old wording).' : 'Run a read-only command.', inputSchema: command,
    ...(annotated ? { title: 'Read-only command', annotations: { readOnlyHint: true, openWorldHint: false } } : {}) },
  ...(extra ? [{ name: 'tail-log', description: 'Tail a log file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] : []),
  ...(annotated ? [{ name: 'status', description: 'Report status.', inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { up: { type: 'boolean' } }, required: ['up'] } }] : []),
  ...(progress ? [{ name: 'long-task', description: 'A task that reports progress.', inputSchema: { type: 'object', properties: {} } }] : []),
  ...(crashable ? [{ name: 'crash', description: 'Exit the backend process mid-call.', inputSchema: { type: 'object', properties: {} } }] : []),
  ...(clash ? [{ name: 'activate', description: 'A real tool that happens to be called activate.', inputSchema: { type: 'object', properties: {} } }] : []),
];

const server = new Server({ name: 'fake-backend', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
const defsArg = argv.find(a => a.startsWith('--defs='));
const defsFile = defsArg ? defsArg.slice('--defs='.length) : undefined;
const readDefs = () => {
  if (!defsFile) return {};
  try { return JSON.parse(readFileSync(defsFile, 'utf-8') || '{}'); } catch { return {}; }
};
const currentTools = () => {
  const defs = readDefs();
  const out = [];
  for (const t of tools) {
    if (!(t.name in defs)) { out.push(t); continue; }
    if (defs[t.name] !== null) out.push({ ...t, ...defs[t.name] });
  }
  for (const [k, v] of Object.entries(defs)) {
    if (k.startsWith('+') && v) out.push({ name: k.slice(1), inputSchema: { type: 'object', properties: {} }, ...v });
  }
  return out;
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: currentTools() }));
if (defsFile) {
  watchFile(defsFile, { interval: 100 }, () => {
    server.sendToolListChanged().catch(() => {});
  });
}
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  if (req.params.name === 'crash') process.exit(1);
  if (req.params.name === 'long-task') {
    const token = req.params._meta?.progressToken;
    if (token !== undefined) {
      for (const n of [1, 2]) {
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: n, total: 2, message: `${name} step ${n}` } });
      }
    }
    const { progressToken: _t, ...meta } = req.params._meta ?? {};
    return { content: [{ type: 'text', text: JSON.stringify({ backend: name, tool: 'long-task', meta, hadToken: token !== undefined }) }] };
  }
  return echo(req);
});
const echo = (req) => ({
  content: [
    { type: 'text', text: JSON.stringify({ backend: name, tool: req.params.name, args: req.params.arguments ?? {} }) },
    { type: 'text', text: 'end' },
  ],
});
const hangIfPid = argValue('--hang-if-pid');
const pinglog = argValue('--pinglog');
const noPing = argv.includes('--no-ping');
const startDelay = Number(argValue('--start-delay-ms') || 0);
if (startDelay > 0) await new Promise(r => setTimeout(r, startDelay));
const transport = new StdioServerTransport();
await server.connect(transport);
if (hangIfPid || pinglog || noPing) {
  const hanging = () => {
    try { return existsSync(hangIfPid) && readFileSync(hangIfPid, 'utf-8').trim() === String(process.pid); } catch { return false; }
  };
  const deliver = transport.onmessage;
  transport.onmessage = (msg, extra) => {
    if (hangIfPid && msg.id !== undefined && hanging()) return; // never answered
    if (msg.method === 'ping') {
      if (pinglog) appendFileSync(pinglog, '1\n');
      if (noPing) {
        transport.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }).catch(() => {});
        return;
      }
    }
    deliver(msg, extra);
  };
}
