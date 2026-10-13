// Read-only view of the ssh-mcp host group ("policy tier") of TOML-configured
// backends, for the admin UI's ssh-mcp policy section.
//
// ssh-mcp authorizes every command against a role x host-group matrix (its
// README, "Policy Engine"). A quick-start backend (--host/--user) carries its
// group in --group=, which the admin UI reads and rewrites from the args alone
// (public/ssh-policy.js). A backend started with --config=<file>.toml keeps a
// group per [[profiles]] entry in that file, which only the gateway can read.
//
// That file also holds hosts, users, key paths and possibly a password, so this
// module never returns its content: it scans for the `name` and `group` keys of
// each [[profiles]] table and nothing else, and drops any value that does not
// look like a plain identifier. No TOML library: two keys need no parser, and a
// parser would hand the whole document to whoever calls it next.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** The built-in tiers. ssh-mcp refuses any other --group on the command line. */
export const SSH_GROUPS = ['prod', 'staging', 'dev'] as const;

/** Bigger than any sane profile file; stops a mistyped --config from reading a disk image. */
export const TOML_MAX_BYTES = 256 * 1024;

const SAFE_VALUE = /^[A-Za-z0-9._@:-]{1,64}$/;

export interface ProfileGroup {
  name: string;
  group: string;
  /** explicit: `group = ` in the profile; inferred: from the profile name, as ssh-mcp does. */
  source: 'explicit' | 'inferred';
}

export interface TomlPolicy {
  configPath: string;
  profiles: ProfileGroup[];
  /** Set when the file could not be read; a code, never file content. */
  error?: string;
}

/** Same match as trifecta.ts backendKind: the package as a path or spec segment. */
export function isSshMcpBackend(conf: any): boolean {
  if (!conf || typeof conf !== 'object') return false;
  const words = [conf.command, ...(Array.isArray(conf.args) ? conf.args : [])]
    .filter((w: unknown): w is string => typeof w === 'string');
  return words.some(w => /(^|[/\\@])ssh-mcp($|[/\\@])/.test(w));
}

/** The --config= value ssh-mcp would use (its parser: last flag wins, `=` only). */
export function configFlag(args: unknown): string | null | undefined {
  let value: string | null | undefined;
  for (const a of Array.isArray(args) ? args : []) {
    if (typeof a !== 'string') continue;
    if (a === '--config') value = null;
    else if (a.startsWith('--config=')) value = a.slice('--config='.length);
  }
  return value;
}

/**
 * ssh-mcp 2.18's resolveProfileGroup: explicit group, else from the profile
 * name, else `prod` (an unrecognised name resolves to the strictest tier).
 */
export function inferGroupFromName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('prod')) return 'prod';
  if (n.includes('staging')) return 'staging';
  if (/\b(dev|local|test|sandbox)\b/.test(n) || /(^|[-_])(dev|local|test|sandbox)([-_]|$)/.test(n)) return 'dev';
  return 'prod';
}

function stringValue(line: string, key: string): string | undefined {
  const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"\\\\]*)"|'([^']*)')\\s*(?:#.*)?$`));
  if (!m) return undefined;
  return m[1] ?? m[2];
}

/** `name` and `group` of every [[profiles]] table; everything else is skipped unread. */
export function profileGroupsFromToml(text: string): ProfileGroup[] {
  const raw: { name?: string; group?: string }[] = [];
  let current: { name?: string; group?: string } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[\[\s*profiles\s*\]\]\s*(#.*)?$/.test(line)) {
      current = {};
      raw.push(current);
      continue;
    }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    if (!current) continue;
    const name = stringValue(line, 'name');
    if (name !== undefined) current.name = name;
    const group = stringValue(line, 'group');
    if (group !== undefined) current.group = group;
  }
  return raw.map((p, i) => {
    const name = p.name && SAFE_VALUE.test(p.name) ? p.name : `profile ${i + 1}`;
    if (p.group !== undefined) {
      return { name, group: SAFE_VALUE.test(p.group) ? p.group : '(unreadable)', source: 'explicit' as const };
    }
    return { name, group: inferGroupFromName(p.name ?? ''), source: 'inferred' as const };
  });
}

/** Read one backend's TOML profile groups. Errors come back as a code. */
export async function readTomlPolicy(configPath: string): Promise<TomlPolicy> {
  // As ssh-mcp opens it: no shell, so no `~` expansion; relative to the cwd.
  const full = path.resolve(configPath);
  try {
    const st = await stat(full);
    if (!st.isFile()) return { configPath, profiles: [], error: 'not a file' };
    if (st.size > TOML_MAX_BYTES) return { configPath, profiles: [], error: 'too large' };
    return { configPath, profiles: profileGroupsFromToml(await readFile(full, 'utf-8')) };
  } catch (e: any) {
    return { configPath, profiles: [], error: typeof e?.code === 'string' ? e.code : 'unreadable' };
  }
}

/**
 * For every ssh-mcp backend started with --config=<file>, its profiles' groups.
 * Quick-start backends are left to the client, which has their args already.
 */
export async function describeTomlPolicies(servers: Record<string, any>): Promise<Record<string, TomlPolicy>> {
  const out: Record<string, TomlPolicy> = {};
  for (const [key, conf] of Object.entries(servers || {})) {
    if (!isSshMcpBackend(conf)) continue;
    const cfg = configFlag(conf.args);
    if (cfg === undefined) continue;
    out[key] = cfg ? await readTomlPolicy(cfg) : { configPath: '', profiles: [], error: 'empty --config' };
  }
  return out;
}
