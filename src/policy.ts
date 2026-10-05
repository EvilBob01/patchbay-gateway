// Per-tool authorization: which identities may see and call which tools.
//
// Identity (identity.ts) answers "who is this?"; this module answers "may they
// do this?". They are deliberately separate steps -- resolve identity, decide
// access, then write the audit record -- so that later checks (lethal-trifecta
// classification, per-session state) slot in as further steps in authorize()
// without touching how identity is resolved.
//
// Model ported from the capability scoping in a sibling fork of this gateway, adapted:
//   - Keyed off the CallerIdentity we already resolve, not a second token lookup.
//   - Rules name a backend and a tool separately ("backend/tool" globs) rather
//     than prefix-matching the qualified name, so a backend called "web" cannot
//     accidentally match "webhooks__..." and the separator never matters.
//   - Evaluated on every request, not frozen into the session at connect time,
//     so a policy edit applies to sessions that are already open.
//   - Opt-in. No policy file means every identity keeps every enabled tool,
//     exactly as before this module existed.
//
// Policy lives in its own file, config/tool_policy.json, and NOT in users.json
// or tool_config.json:
//   - users.json holds live secrets and is rewritten wholesale on every user
//     add/revoke; policy must be reviewable and diffable without exposing tokens.
//   - tool_config.json is global presentation config (enable/rename/describe)
//     that the admin Tools tab posts back verbatim; it would clobber keys it does
//     not know about.
//
// File format (all keys optional; unknown top-level keys are ignored so later
// features can extend the file without breaking older builds):
//
//   {
//     "default": { "allow": ["*"] },              // anyone without an entry below
//     "static":  { "allow": ["*"] },              // the ALLOWED_TOKENS/KEYS credential
//     "roles":   { "readonly": { "allow": ["*/read-command", "*/list-*"] } },
//     "users": {
//       "alice": { "allow": ["forgejo/*"] },
//       "bob":   { "role": "readonly", "deny": ["billing/*"] }
//     }
//   }
//
// A pattern is "*" (everything) or "<backend-glob>/<tool-glob>", where "*"
// matches any run of characters. Backend and tool are the ORIGINAL names from
// mcp_server.json and the backend's own tools/list -- exposed-name overrides in
// tool_config.json are cosmetic and do not affect policy. deny beats allow. A
// rule with no "allow" key allows nothing; a missing "default" means allow all.
import { readFile, stat, writeFile, rename } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import type { CallerIdentity } from './identity.js';
import { compileTrifecta, DEFAULT_TRIFECTA, type TrifectaConfig } from './trifecta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_POLICY_PATH = process.env.MCP_TOOL_POLICY_PATH
  || path.resolve(__dirname, '..', 'config', 'tool_policy.json');

/** JSON-RPC error code returned for a tools/call the policy rejects. */
export const AUTHZ_DENIED_CODE = -32003;

export interface PolicyRule {
  allow?: string[];
  deny?: string[];
  /** users.* only: inherit a named role's allow/deny, then add this entry's. */
  role?: string;
}

export interface ToolPolicyFile {
  default?: PolicyRule;
  static?: PolicyRule;
  roles?: Record<string, PolicyRule>;
  users?: Record<string, PolicyRule>;
  [extension: string]: unknown;
}

/** The thing being authorized. Extend here, not in callers' argument lists. */
export interface AuthzRequest {
  identity: CallerIdentity;
  backend: string;
  tool: string;
  sessionId?: string;
}

export interface AuthzDecision {
  allowed: boolean;
  /** Which part of the policy decided, for the audit trail, e.g. "users.alice". */
  rule: string;
  reason: string;
}

interface CompiledRule {
  name: string;
  allow: Matcher[];
  deny: Matcher[];
}

interface Matcher { backend: RegExp; tool: RegExp }

/** What the rest of the gateway asks. Pure; safe to call many times per request. */
export interface CompiledPolicy {
  /** False when no policy file exists -- the "nothing configured" fast path. */
  configured: boolean;
  decide(req: AuthzRequest): AuthzDecision;
  /**
   * The "trifecta" section (lethal-trifecta classification and per-session
   * blocking, see trifecta.ts), compiled with the rest of the file so that it
   * shares its live reload, admin-API validation and fail-closed handling.
   * Built-in defaults when the section or the whole file is absent.
   */
  trifecta: TrifectaConfig;
}

// --- compilation -----------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function compilePattern(p: unknown, where: string): Matcher {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error(`${where}: patterns must be non-empty strings`);
  }
  if (p === '*') return { backend: /^.*$/, tool: /^.*$/ };
  const slash = p.indexOf('/');
  // Require the separator: a bare "forgejo" is ambiguous (backend? tool?) and
  // the safe reading of an ambiguous security rule is "reject the file".
  if (slash <= 0 || slash === p.length - 1) {
    throw new Error(`${where}: pattern "${p}" must be "*" or "<backend>/<tool>" (use "${p}/*" for a whole backend)`);
  }
  return { backend: globToRegExp(p.slice(0, slash)), tool: globToRegExp(p.slice(slash + 1)) };
}

function compileList(list: unknown, where: string): Matcher[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${where}: must be an array of patterns`);
  return list.map((p, i) => compilePattern(p, `${where}[${i}]`));
}

function assertRuleShape(rule: unknown, where: string, allowRole: boolean): asserts rule is PolicyRule {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    throw new Error(`${where}: must be an object`);
  }
  for (const k of Object.keys(rule)) {
    if (k !== 'allow' && k !== 'deny' && !(allowRole && k === 'role')) {
      throw new Error(`${where}: unknown key "${k}"`);
    }
  }
}

function compileRule(name: string, rule: unknown, roles: Record<string, CompiledRule>, allowRole: boolean): CompiledRule {
  assertRuleShape(rule, name, allowRole);
  const out: CompiledRule = { name, allow: compileList(rule.allow, `${name}.allow`), deny: compileList(rule.deny, `${name}.deny`) };
  if (rule.role !== undefined) {
    const base = typeof rule.role === 'string' ? roles[rule.role] : undefined;
    if (!base) throw new Error(`${name}.role: unknown role ${JSON.stringify(rule.role)}`);
    out.allow = [...base.allow, ...out.allow];
    out.deny = [...base.deny, ...out.deny];
  }
  return out;
}

function matchesAny(ms: Matcher[], backend: string, tool: string): boolean {
  return ms.some(m => m.backend.test(backend) && m.tool.test(tool));
}

const ALLOW_ALL_RULE: CompiledRule = { name: 'default(implicit)', allow: [compilePattern('*', '')], deny: [] };

/** No file: everyone keeps everything. This is the pre-authz behaviour. */
export const NO_POLICY: CompiledPolicy = Object.freeze({
  configured: false,
  decide: (): AuthzDecision => ({ allowed: true, rule: 'none', reason: 'no tool policy configured' }),
  trifecta: DEFAULT_TRIFECTA,
});

/** Unreadable/invalid file: nobody gets anything until it is fixed. */
const denyAllPolicy = (why: string): CompiledPolicy => ({
  configured: true,
  decide: () => ({ allowed: false, rule: 'invalid-policy', reason: `tool policy is invalid: ${why}` }),
  trifecta: DEFAULT_TRIFECTA,
});

/**
 * Validate and compile a parsed policy file. Throws with a human-readable
 * message on anything malformed; callers decide what failure means.
 */
export function compilePolicy(raw: unknown): CompiledPolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('policy must be a JSON object');
  }
  const file = raw as ToolPolicyFile;

  const roles: Record<string, CompiledRule> = {};
  if (file.roles !== undefined) {
    if (typeof file.roles !== 'object' || file.roles === null || Array.isArray(file.roles)) throw new Error('roles: must be an object');
    for (const [name, rule] of Object.entries(file.roles)) roles[name] = compileRule(`roles.${name}`, rule, roles, false);
  }

  const users: Record<string, CompiledRule> = {};
  if (file.users !== undefined) {
    if (typeof file.users !== 'object' || file.users === null || Array.isArray(file.users)) throw new Error('users: must be an object');
    for (const [name, rule] of Object.entries(file.users)) users[name] = compileRule(`users.${name}`, rule, roles, true);
  }

  const dflt = file.default !== undefined ? compileRule('default', file.default, roles, false) : ALLOW_ALL_RULE;
  const staticRule = file.static !== undefined ? compileRule('static', file.static, roles, false) : undefined;
  const trifecta = compileTrifecta(file.trifecta);

  const ruleFor = (id: CallerIdentity): CompiledRule | null => {
    switch (id.kind) {
      case 'user': return users[id.username] ?? dflt;
      case 'static': return staticRule ?? dflt;
      case 'anonymous': return dflt; // auth disabled entirely: nobody to tell apart
      // A request whose session has no resolved identity. Unreachable in normal
      // operation (every session is bound at connect); if it ever happens with a
      // policy in force, fail closed rather than hand out the default.
      default: return null;
    }
  };

  return {
    configured: true,
    trifecta,
    decide({ identity, backend, tool }: AuthzRequest): AuthzDecision {
      const rule = ruleFor(identity);
      if (!rule) return { allowed: false, rule: 'unknown-identity', reason: 'caller identity could not be resolved' };
      if (matchesAny(rule.deny, backend, tool)) return { allowed: false, rule: rule.name, reason: 'matched deny' };
      if (matchesAny(rule.allow, backend, tool)) return { allowed: true, rule: rule.name, reason: 'matched allow' };
      return { allowed: false, rule: rule.name, reason: 'not in allow list' };
    },
  };
}

// --- live loading ----------------------------------------------------------
//
// Same live-edit property as users.json: no restart, no reload button. The file
// is stat()ed on each lookup and only re-parsed when its mtime or size moves,
// so the steady-state cost is one stat per tools/list or tools/call.
// Failures are never cached: a read that lands mid-write is retried next time.

let cache: { mtimeMs: number; size: number; policy: CompiledPolicy } | null = null;
let lastState = '';

function logTransition(state: string, msg: string, level: 'log' | 'warn' | 'error' = 'log') {
  if (state === lastState) return; // say it once per change, not once per request
  lastState = state;
  logger[level](msg);
}

export async function currentPolicy(): Promise<CompiledPolicy> {
  let st;
  try {
    st = await stat(TOOL_POLICY_PATH);
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      cache = null;
      logTransition('absent', `Tool policy: ${TOOL_POLICY_PATH} not present -- all identities may use all enabled tools.`);
      return NO_POLICY;
    }
    logTransition(`staterr:${e?.code}`, `Tool policy: cannot stat ${TOOL_POLICY_PATH} (${e?.message}); denying all tool access until fixed.`, 'error');
    return denyAllPolicy(`cannot stat file: ${e?.code || e?.message}`);
  }

  if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.policy;

  try {
    const policy = compilePolicy(JSON.parse(await readFile(TOOL_POLICY_PATH, 'utf-8')));
    cache = { mtimeMs: st.mtimeMs, size: st.size, policy };
    logTransition(`ok:${st.mtimeMs}:${st.size}`, `Tool policy: loaded ${TOOL_POLICY_PATH}.`);
    return policy;
  } catch (e: any) {
    cache = null;
    // Fail closed, consistently -- a typo must not silently widen access, and
    // keeping a last-known-good copy would make behaviour differ across a
    // restart. The admin API validates before writing, so this only bites
    // hand edits, and it says so loudly.
    logTransition(`bad:${st.mtimeMs}:${st.size}`, `Tool policy: ${TOOL_POLICY_PATH} is invalid (${e?.message}); denying all tool access until fixed.`, 'error');
    return denyAllPolicy(e?.message || String(e));
  }
}

/** Read the raw file for the admin API. null when absent. */
export async function readPolicyFile(): Promise<string | null> {
  try {
    return await readFile(TOOL_POLICY_PATH, 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Validate, then write atomically (tmp + rename) so a concurrent reader never
 * sees a half-written file. Throws on invalid input without touching the file.
 */
export async function writePolicyFile(raw: unknown): Promise<void> {
  compilePolicy(raw);
  const tmp = `${TOOL_POLICY_PATH}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await rename(tmp, TOOL_POLICY_PATH);
}
