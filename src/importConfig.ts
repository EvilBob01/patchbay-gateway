// Import backends from an MCP client's config file (admin UI "Import from client
// config"). The admin pastes or uploads e.g. claude_desktop_config.json; the
// gateway turns each entry into a backend, says what it cannot run here, and
// shows a preview with every secret masked. The admin picks entries and the
// gateway writes them to mcp_server.json and reloads.
//
// Supported input shapes (JSON, comments and trailing commas tolerated):
//   { "mcpServers": { ... } }  Claude Desktop, Claude Code (.mcp.json and
//                               ~/.claude.json top level), Cursor, Windsurf, Cline
//   { "servers": { ... } }      VS Code .vscode/mcp.json
//   { "mcp": { "servers": ... } } VS Code settings.json
//
// The full (unmasked) entries never go back to the browser: the preview is kept
// server-side under a random id bound to the admin's session, and the import
// call names entries by id. See docs/configuration.md "Importing from a client
// config".
import { accessSync, constants as fsConstants, existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { TransportConfig } from './config.js';
import { maskSecret, maskUrl, maskArg, maskArgs, maskEnvValue } from './configSecrets.js';

export const SERVER_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
// Below express.json()'s 100 KB body limit; real client configs are a few KB.
export const MAX_IMPORT_TEXT = 90 * 1024;

export type ImportFormat = 'mcpServers' | 'vscode';
export type IssueLevel = 'info' | 'warn' | 'error';
export interface ImportIssue { level: IssueLevel; message: string }

export interface ImportCandidate {
  id: string;
  sourceName: string;
  /** Proposed backend key: the sanitised source name, made unique if it clashes. */
  key: string;
  /** The source name's key already exists in mcp_server.json. */
  clash: boolean;
  clashKey?: string;
  config: TransportConfig;
  issues: ImportIssue[];
  /** false when an error-level issue means the gateway cannot run this entry. */
  importable: boolean;
}

export interface ImportContext {
  existingKeys: string[];
  platform: string;
  commandExists: (command: string) => boolean;
  pathExists: (p: string) => boolean;
}

export function defaultImportContext(existingKeys: string[]): ImportContext {
  return { existingKeys, platform: process.platform, commandExists: commandOnPath, pathExists: existsSync };
}

function commandOnPath(command: string): boolean {
  if (path.isAbsolute(command)) return isExecutable(command);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (isExecutable(path.join(dir, command + ext))) return true;
  }
  return false;
}

function isExecutable(p: string): boolean {
  try { accessSync(p, fsConstants.X_OK); return true; } catch { return false; }
}

/** Strip // and /* *\/ comments and trailing commas outside strings (JSONC, as VS Code writes it). */
export function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) out += text[++i];
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true; out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '}' && text[j] !== ']') out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function detectServers(parsed: unknown): { format: ImportFormat; servers: Record<string, any> } {
  if (!isPlainObject(parsed)) throw new Error('Expected a JSON object.');
  if (isPlainObject(parsed.mcpServers)) return { format: 'mcpServers', servers: parsed.mcpServers };
  if (isPlainObject(parsed.servers)) return { format: 'vscode', servers: parsed.servers };
  if (isPlainObject(parsed.mcp) && isPlainObject(parsed.mcp.servers)) return { format: 'vscode', servers: parsed.mcp.servers };
  throw new Error('No "mcpServers" (Claude Desktop, Claude Code, Cursor) or "servers" (VS Code) object found.');
}

export function sanitizeKey(name: string): string {
  const key = name.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return key || 'imported';
}

function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

const WIN_ABS_RE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const WIN_LAUNCHERS = new Set(['npx', 'npm', 'node', 'uvx', 'uv', 'python', 'python3', 'py', 'pipx',
  'deno', 'bun', 'bunx', 'pnpm', 'yarn', 'docker', 'podman']);
const PLACEHOLDER_RE = /\$\{(?:input|env|workspaceFolder|userHome|pathSeparator|config)[^}]*\}/;

function looksRelativePath(s: string): boolean {
  return /^\.{1,2}[\\/]/.test(s);
}

/** Turn one client entry into a gateway backend config plus the problems found. */
export function convertEntry(name: string, raw: any, ctx: ImportContext): { config: TransportConfig | null; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const add = (level: IssueLevel, message: string) => issues.push({ level, message });
  const onWindows = ctx.platform === 'win32';

  if (!isPlainObject(raw)) {
    add('error', 'Entry is not an object.');
    return { config: null, issues };
  }

  const scan = (label: string, s: string) => {
    if (PLACEHOLDER_RE.test(s)) add('warn', `${label} contains a client-side placeholder (${s.match(PLACEHOLDER_RE)![0]}) the gateway does not expand; edit it after import.`);
  };

  const active = raw.disabled === true ? false : raw.active === false ? false : true;
  if (!active) add('info', 'Disabled in the client config; imported as inactive.');

  const declared = typeof raw.type === 'string' ? raw.type.toLowerCase() : (typeof raw.transportType === 'string' ? raw.transportType.toLowerCase() : undefined);

  if (typeof raw.url === 'string' || typeof raw.serverUrl === 'string') {
    const url: string = raw.url ?? raw.serverUrl;
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { add('error', `Invalid URL: ${maskUrl(url)}`); return { config: null, issues }; }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      add('error', `Unsupported URL scheme ${parsedUrl.protocol}`);
      return { config: null, issues };
    }
    scan('URL', url);
    let type: 'sse' | 'http';
    if (declared === 'sse') type = 'sse';
    else if (declared && ['http', 'streamable-http', 'streamablehttp', 'streamable_http'].includes(declared)) type = 'http';
    else type = /\/sse\/?$/.test(parsedUrl.pathname) ? 'sse' : 'http';

    const config: any = { type, name, url, active };
    const headers = isPlainObject(raw.headers) ? raw.headers : {};
    for (const [h, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;
      scan(`Header ${h}`, value);
      const lower = h.toLowerCase();
      const bearer = /^bearer\s+(.+)$/i.exec(value);
      if (lower === 'authorization' && bearer) config.bearerToken = bearer[1].trim();
      else if (lower === 'x-api-key') config.apiKey = value;
      else add('warn', `Header "${h}" dropped: the gateway only sends "Authorization: Bearer" or "X-Api-Key" to a backend.`);
    }
    if (config.bearerToken && config.apiKey) {
      add('warn', 'Both a Bearer token and an X-Api-Key were given; the gateway sends only the Bearer token.');
    }
    if (raw.oauth || raw.auth) add('warn', 'OAuth settings are not supported for backends; the entry needs a static token.');
    return { config, issues };
  }

  if (typeof raw.command !== 'string' || raw.command.trim() === '') {
    add('error', 'No "command" or "url" found.');
    return { config: null, issues };
  }
  if (declared && declared !== 'stdio') add('warn', `Declared type "${raw.type}" ignored; the entry has a command, so it runs as stdio.`);

  let command: string = raw.command.trim();
  let args: string[] = Array.isArray(raw.args) ? raw.args.map((a: unknown) => String(a)) : [];

  // `cmd /c npx -y pkg` is the Windows idiom for launching .cmd shims; the
  // command after /c is what actually runs.
  const base = path.win32.basename(command).toLowerCase();
  if (!onWindows && (base === 'cmd' || base === 'cmd.exe') && /^\/[ck]$/i.test(args[0] || '') && args.length > 1) {
    command = args[1];
    args = args.slice(2);
    add('info', `Unwrapped the Windows "cmd /c" launcher; runs "${command}" directly.`);
  }
  if (!onWindows && /^(powershell|pwsh)(\.exe)?$/i.test(path.win32.basename(command))) {
    add('error', 'Launched through PowerShell, which this gateway host does not run.');
    return { config: null, issues };
  }

  if (!onWindows) {
    const m = /^(.*?)(?:\.(cmd|exe|bat))$/i.exec(path.win32.basename(command));
    if (m && WIN_LAUNCHERS.has(m[1].toLowerCase()) && !command.includes('\\') && !command.includes('/')) {
      add('info', `Using "${m[1].toLowerCase()}" instead of the Windows shim "${command}".`);
      command = m[1].toLowerCase();
    } else if (WIN_ABS_RE.test(command) || command.includes('\\') || /\.(cmd|exe|bat|ps1)$/i.test(command)) {
      add('error', `Command "${command}" is a Windows path or program; it cannot run on this gateway host.`);
      return { config: null, issues };
    }
  }

  if (looksRelativePath(command) || (!path.isAbsolute(command) && /[\\/]/.test(command))) {
    add('error', `Command "${command}" is a relative path, resolved against the client's working directory; use an absolute path on the gateway host.`);
    return { config: null, issues };
  }
  if (command.startsWith('~')) {
    add('error', `Command "${command}" starts with "~", which is not expanded when the gateway starts a backend.`);
    return { config: null, issues };
  }
  scan('Command', command);
  if (!ctx.commandExists(command)) {
    add('warn', `"${command}" was not found on the gateway host${path.isAbsolute(command) ? '' : "'s PATH"}; install it before activating this backend.`);
  }

  let blocked = false;
  args.forEach((arg, i) => {
    // With the previous argument, so "--password /x" is masked in these messages too.
    const shown = maskArg(arg, args[i - 1]);
    scan('An argument', arg);
    if (!onWindows && WIN_ABS_RE.test(arg)) {
      add('error', `Argument "${shown}" is a Windows path; it cannot exist on this gateway host.`);
      blocked = true;
    } else if (looksRelativePath(arg)) {
      add('error', `Argument "${shown}" is a relative path, resolved against the client's working directory; use an absolute path on the gateway host.`);
      blocked = true;
    } else if (/^~[\\/]/.test(arg)) {
      add('warn', `Argument "${shown}" starts with "~", which is not expanded; use an absolute path.`);
    } else if ((onWindows ? WIN_ABS_RE.test(arg) : path.posix.isAbsolute(arg) && !arg.startsWith('//')) && !ctx.pathExists(arg)) {
      add('warn', `Path "${shown}" does not exist on the gateway host; it probably refers to the client machine.`);
    }
  });
  if (blocked) return { config: null, issues };

  const env: Record<string, string> = {};
  if (isPlainObject(raw.env)) {
    for (const [k, v] of Object.entries(raw.env)) {
      if (v === null || v === undefined) continue;
      env[k] = String(v);
      scan(`Env ${k}`, env[k]);
      if (env[k] === '') add('warn', `Env ${k} is empty.`);
    }
  }
  if (raw.envFile) add('warn', `"envFile" is not supported; copy the variables into the entry's env after import.`);
  if (raw.cwd) add('warn', `"cwd" (${raw.cwd}) is not supported; backends start in the gateway's directory.`);

  const config: any = { type: 'stdio', name, command, args, active };
  if (Object.keys(env).length) config.env = env;
  return { config, issues };
}

/** For an entry that cannot be imported: enough of it to show in the preview. */
function displayOnlyConfig(name: string, raw: any): TransportConfig {
  const r = isPlainObject(raw) ? raw : {};
  if (typeof r.url === 'string') return { type: 'http', name, url: r.url, active: false };
  const env = isPlainObject(r.env) ? Object.fromEntries(Object.entries(r.env).map(([k, v]) => [k, String(v)])) : undefined;
  return {
    type: 'stdio', name, active: false,
    command: typeof r.command === 'string' ? r.command : '',
    args: Array.isArray(r.args) ? r.args.map((a: unknown) => String(a)) : [],
    ...(env ? { env } : {}),
  };
}

export function parseClientConfig(text: string, ctx: ImportContext): { format: ImportFormat; candidates: ImportCandidate[] } {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('Nothing to import: the config is empty.');
  if (text.length > MAX_IMPORT_TEXT) throw new Error(`Config is larger than ${MAX_IMPORT_TEXT / 1024} KB.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text.replace(/^﻿/, '')));
  } catch (e: any) {
    throw new Error(`Not valid JSON: ${e.message}`);
  }
  const { format, servers } = detectServers(parsed);
  const existing = new Set(ctx.existingKeys);
  const taken = new Set(ctx.existingKeys);
  const candidates: ImportCandidate[] = [];
  for (const [sourceName, raw] of Object.entries(servers)) {
    const { config, issues } = convertEntry(sourceName, raw, ctx);
    const baseKey = sanitizeKey(sourceName);
    if (baseKey !== sourceName) issues.push({ level: 'info', message: `Key changed to "${baseKey}" (letters, digits, "-" and "_" only).` });
    const clash = existing.has(baseKey);
    const key = uniqueKey(baseKey, taken);
    taken.add(key);
    if (clash) issues.push({ level: 'warn', message: `A backend named "${baseKey}" already exists; proposed "${key}" instead (or choose to replace it).` });
    candidates.push({
      id: crypto.randomBytes(6).toString('hex'),
      sourceName, key, clash, clashKey: clash ? baseKey : undefined,
      config: config ?? displayOnlyConfig(sourceName, raw),
      issues,
      importable: config !== null && !issues.some(i => i.level === 'error'),
    });
  }
  return { format, candidates };
}

// ---- masking --------------------------------------------------------------
// One set of rules for the preview and the Servers tab: configSecrets.ts.

export { maskSecret, maskUrl };

export interface MaskedCandidate {
  id: string;
  sourceName: string;
  key: string;
  clash: boolean;
  clashKey?: string;
  importable: boolean;
  issues: ImportIssue[];
  type: string;
  active: boolean;
  command?: string;
  args?: string[];
  url?: string;
  env?: { name: string; value: string }[];
  auth?: { kind: 'bearer' | 'apiKey'; value: string };
}

export function maskCandidate(c: ImportCandidate): MaskedCandidate {
  const cfg: any = c.config;
  const out: MaskedCandidate = {
    id: c.id, sourceName: c.sourceName, key: c.key, clash: c.clash, clashKey: c.clashKey,
    importable: c.importable, issues: c.issues, type: cfg.type, active: cfg.active !== false,
  };
  if (cfg.type === 'stdio') {
    out.command = cfg.command;
    out.args = maskArgs(cfg.args || []) as string[];
    out.env = Object.entries(cfg.env || {}).map(([name, value]) => ({ name, value: String(maskEnvValue(name, String(value))) }));
  } else {
    out.url = maskUrl(cfg.url);
    if (cfg.bearerToken) out.auth = { kind: 'bearer', value: maskSecret(cfg.bearerToken) };
    else if (cfg.apiKey) out.auth = { kind: 'apiKey', value: maskSecret(cfg.apiKey) };
  }
  return out;
}

// ---- server-side preview store --------------------------------------------

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const MAX_PREVIEWS = 50;
interface StoredPreview { owner: string; createdAt: number; candidates: ImportCandidate[] }
const previews = new Map<string, StoredPreview>();

function prunePreviews(now = Date.now()) {
  for (const [id, p] of previews) if (now - p.createdAt > PREVIEW_TTL_MS) previews.delete(id);
  while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value as string);
}

/** Keep a preview's full entries for the import step; `owner` is the admin session id. */
export function storePreview(owner: string, candidates: ImportCandidate[]): string {
  prunePreviews();
  const id = crypto.randomBytes(16).toString('hex');
  previews.set(id, { owner, createdAt: Date.now(), candidates });
  return id;
}

export function takePreview(id: string, owner: string): ImportCandidate[] | null {
  prunePreviews();
  const p = typeof id === 'string' ? previews.get(id) : undefined;
  if (!p || p.owner !== owner) return null;
  return p.candidates;
}

export function dropPreview(id: string): void {
  previews.delete(id);
}

// ---- apply ------------------------------------------------------------------

export interface ImportSelection { id: string; key: string; replace?: boolean }

/**
 * Merge the selected candidates into `servers` (mcp_server.json's mcpServers,
 * mutated in place). Throws with a message listing every problem; on error
 * nothing is changed.
 */
export function applySelections(servers: Record<string, any>, candidates: ImportCandidate[], selections: ImportSelection[]): string[] {
  if (!Array.isArray(selections) || selections.length === 0) throw new Error('Select at least one entry to import.');
  const byId = new Map(candidates.map(c => [c.id, c]));
  const problems: string[] = [];
  const keys = new Set<string>();
  const planned: [string, TransportConfig][] = [];
  for (const sel of selections) {
    const c = sel && byId.get(sel.id);
    if (!c) { problems.push(`Unknown entry ${String(sel?.id)}.`); continue; }
    if (!c.importable) { problems.push(`"${c.sourceName}" cannot run on this gateway and was not imported.`); continue; }
    const key = typeof sel.key === 'string' ? sel.key.trim() : '';
    if (!SERVER_KEY_RE.test(key)) { problems.push(`"${key}" is not a valid backend name (letters, digits, "-" and "_", up to 64).`); continue; }
    if (keys.has(key)) { problems.push(`Backend name "${key}" is used twice.`); continue; }
    if (Object.prototype.hasOwnProperty.call(servers, key) && sel.replace !== true) {
      problems.push(`A backend named "${key}" already exists; rename the entry or choose replace.`);
      continue;
    }
    keys.add(key);
    planned.push([key, { ...c.config } as TransportConfig]);
  }
  if (problems.length) throw new Error(problems.join(' '));
  for (const [key, cfg] of planned) servers[key] = cfg;
  return planned.map(([key]) => key);
}
