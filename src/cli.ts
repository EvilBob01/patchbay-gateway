#!/usr/bin/env node
// `patchbay-gateway` command, used by `npx patchbay-gateway` for a quick local
// trial. It keeps everything under one data directory (default
// ~/.patchbay-gateway), creates it with generated credentials on first run,
// loads it into the environment and starts the HTTP gateway with the admin UI on
// 127.0.0.1. Variables already set in the environment always win.
//
// A server install uses scripts/install.sh and systemd instead; that runs
// build/sse.js directly with /etc/patchbay-gateway.env and never touches this.
//
// Nothing from ./ is imported statically: the gateway modules read
// PATCHBAY_CONFIG_DIR and friends when they load, so they are imported only
// after the environment is set up.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const HELP = `Usage: patchbay-gateway [start] [options]
       patchbay-gateway stdio

Commands:
  start        Run the HTTP gateway with the admin UI (default).
  stdio        Run as a single stdio MCP server (for an MCP client to spawn).

Options:
  --port <n>       Port to listen on (default 3663, or PORT).
  --host <addr>    Address to bind (default 127.0.0.1, or BIND_HOST).
                   Use 0.0.0.0 to accept connections from other machines.
  --data-dir <d>   Where config, credentials and the audit log live
                   (default ~/.patchbay-gateway, or PATCHBAY_HOME).
  -h, --help       Show this help.
  -v, --version    Show the version.

First run creates <data-dir>/gateway.env with a generated admin password,
session secret and client token, and prints them once.`;

function fail(message: string): never {
  console.error(`patchbay-gateway: ${message}\n\n${HELP}`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const opts: { command: string; port?: string; host?: string; dataDir?: string } = { command: 'start' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} needs a value`);
    if (arg === '-h' || arg === '--help') { console.log(HELP); process.exit(0); }
    else if (arg === '-v' || arg === '--version') {
      const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'));
      console.log(pkg.version); process.exit(0);
    }
    else if (arg === '--port') opts.port = value();
    else if (arg === '--host') opts.host = value();
    else if (arg === '--data-dir') opts.dataDir = value();
    else if (arg === 'start' || arg === 'stdio') opts.command = arg;
    else fail(`unknown argument "${arg}"`);
  }
  if (opts.port !== undefined && !/^\d{1,5}$/.test(opts.port)) fail('--port must be a number');
  return opts;
}

/** Parse KEY=VALUE lines (the same format as the systemd EnvironmentFile). */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function secret(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function ensureDataDir(dataDir: string): { envFile: string; created: Record<string, string> | null } {
  for (const dir of [dataDir, path.join(dataDir, 'config'), path.join(dataDir, 'audit'), path.join(dataDir, 'tools')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const serverConfig = path.join(dataDir, 'config', 'mcp_server.json');
  if (!existsSync(serverConfig)) writeFileSync(serverConfig, JSON.stringify({ mcpServers: {} }, null, 2) + '\n', { mode: 0o600 });

  const envFile = path.join(dataDir, 'gateway.env');
  if (existsSync(envFile)) return { envFile, created: null };
  const token = secret(24);
  const created = {
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: secret(18),
    SESSION_SECRET: secret(32),
    ALLOWED_TOKENS: token,
    ALLOWED_KEYS: token,
  };
  const body = '# Created by `patchbay-gateway` on first run. Keep this file private.\n' +
    Object.entries(created).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(envFile, body, { mode: 0o600 });
  try { chmodSync(envFile, 0o600); } catch { /* Windows */ }
  return { envFile, created };
}

const opts = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(opts.dataDir || process.env.PATCHBAY_HOME || path.join(homedir(), '.patchbay-gateway'));
const { envFile, created } = ensureDataDir(dataDir);

const fromFile = parseEnvFile(readFileSync(envFile, 'utf-8'));
for (const [k, v] of Object.entries(fromFile)) if (process.env[k] === undefined) process.env[k] = v;

const setDefault = (name: string, value: string) => { if (!process.env[name]?.trim()) process.env[name] = value; };
process.env.PATCHBAY_CONFIG_DIR = path.join(dataDir, 'config');
setDefault('MCP_AUDIT_DIR', path.join(dataDir, 'audit'));
setDefault('TOOLS_FOLDER', path.join(dataDir, 'tools'));
setDefault('ENABLE_ADMIN_UI', 'true');
if (opts.port) process.env.PORT = opts.port;
if (opts.host) process.env.BIND_HOST = opts.host;
setDefault('BIND_HOST', '127.0.0.1');
setDefault('PORT', '3663');

if (opts.command === 'stdio') {
  await import('./index.js');
} else {
  const host = process.env.BIND_HOST!;
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${shown}:${process.env.PORT}`;
  // stderr, so the summary is not lost among the gateway's own stdout logging.
  if (created) {
    console.error([
      '',
      `Patchbay Gateway: created ${dataDir}`,
      '',
      '  These credentials are shown once. They are also stored in',
      `  ${envFile}`,
      '',
      `  Admin UI:      ${url}/admin`,
      `  Admin login:   ${created.ADMIN_USERNAME} / ${created.ADMIN_PASSWORD}`,
      `  Client token:  ${created.ALLOWED_TOKENS}`,
      `  MCP endpoint:  ${url}/mcp  (header "Authorization: Bearer <client token>")`,
      '',
    ].join('\n'));
  } else {
    console.error(`Patchbay Gateway: using ${dataDir} (credentials in ${envFile})\n  Admin UI: ${url}/admin\n`);
  }
  await import('./sse.js');
}
