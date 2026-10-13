// Tool collapsing: publish a tool that several backends expose identically
// ONCE, with a `host` argument that picks the backend, instead of once per
// backend.
//
// Why: every ssh-mcp backend exposes the same 14 tool definitions byte for
// byte, so tools/list grows by ~2,000 tokens per ssh host. Collapsing turns
// 20 x `<host>__run-command` into one `ssh__run-command` with
// `host: enum[...]`.
//
// Presentation and routing only. A collapsed call is rewritten to the real
// `<backend><sep><tool>` before anything else looks at it, so authorization,
// trifecta, audit (toolKey/backend), rate limits and result shaping all see the
// real backend exactly as they would without collapsing.
//
// Grouping is automatic and conservative:
//   - Only backends of the same known kind (trifecta.ts backendKind: from the
//     command line, or pinned in trifecta.backendKinds) are candidates.
//     `unknown` backends never collapse.
//   - Per tool name, candidates are split by a fingerprint of the published
//     definition (description, inputSchema, title, annotations and
//     outputSchema, canonical JSON). The largest split
//     with two or more members collapses; everything else stays per-host. A
//     backend with a drifted schema, a missing tool or extra tools therefore
//     keeps its own names for exactly the tools that differ.
//   - The collapsed tool carries the shared title, annotations and
//     outputSchema. They are part of the fingerprint rather than merged, so a
//     host whose readOnlyHint/destructiveHint differs stays per-host with its
//     own hints instead of the gateway inventing a combined set.
//   - Never collapsed: a tool renamed or re-described in tool_config.json, a
//     tool whose schema already has a `host` property, and a tool whose
//     collapsed name would clash with an existing tool name.
//
// Off unless MCP_COLLAPSE_TOOLS=true; a per-user `collapseTools` in users.json
// overrides that in either direction. Off means tools/list and tools/call are
// untouched. With it on, the per-host names of collapsed tools are no longer
// listed but stay callable, so existing prompts keep working.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CallerIdentity } from './identity.js';

/** Gateway-wide default. Off unless MCP_COLLAPSE_TOOLS=true. */
export const COLLAPSE_TOOLS_DEFAULT = process.env.MCP_COLLAPSE_TOOLS === 'true';

/** The argument that selects the backend of a collapsed tool. */
export const HOST_PARAM = 'host';

/** Per-user `collapseTools` (carried on the identity) wins over the gateway default. */
export function shouldCollapseTools(
  identity: CallerIdentity | undefined,
  gatewayDefault: boolean = COLLAPSE_TOOLS_DEFAULT,
): boolean {
  return identity?.collapseTools ?? gatewayDefault;
}

export function collapseToolsConfigSummary(): string {
  return `Tool collapsing: ${COLLAPSE_TOOLS_DEFAULT ? 'ON' : 'off'} by default` +
    ' (MCP_COLLAPSE_TOOLS; per-user collapseTools in users.json overrides)';
}

/** One enabled backend tool, as the gateway holds it. */
export interface CollapseCandidate {
  /** Qualified name, `<backend><sep><tool>`. */
  key: string;
  backend: string;
  tool: Tool;
  /** trifecta.ts backendKind for the backend. */
  kind: string;
  /** Name the tool is published under (tool_config.json exposedName, else key). */
  exposedName: string;
  /** Renamed or re-described in tool_config.json. */
  overridden: boolean;
}

export interface CollapsedTool {
  /** Published name, e.g. `ssh__run-command`. */
  name: string;
  /** The backend tool's own name, e.g. `run-command`. */
  toolName: string;
  /** Definition shared by every member (taken from the first). */
  template: Tool;
  /** backend -> qualified key, in backend-name order. */
  members: Map<string, string>;
}

export interface CollapsePlan {
  /** Published name -> collapsed tool. */
  tools: Map<string, CollapsedTool>;
  /** Qualified key -> published name of the collapsed tool it belongs to. */
  memberOf: Map<string, string>;
  /** Tools that looked collapsible but were left alone, and why. */
  warnings: string[];
}

export const EMPTY_PLAN: CollapsePlan = Object.freeze({
  tools: new Map(), memberOf: new Map(), warnings: [],
}) as CollapsePlan;

/** JSON with object keys sorted at every level; array order kept. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
      : v);

/** The part of a definition that tools/list publishes, minus the name. */
const fingerprint = (tool: Tool): string =>
  canonical({
    description: tool.description ?? null, inputSchema: tool.inputSchema ?? null,
    title: tool.title ?? null, annotations: tool.annotations ?? null, outputSchema: tool.outputSchema ?? null,
  });

/** `ssh-mcp` -> `ssh`; other kinds as they are. */
export const kindPrefix = (kind: string): string => kind.replace(/-mcp$/, '');

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildCollapsePlan(candidates: CollapseCandidate[], separator: string): CollapsePlan {
  const plan: CollapsePlan = { tools: new Map(), memberOf: new Map(), warnings: [] };
  const taken = new Set<string>();
  for (const c of candidates) { taken.add(c.key); taken.add(c.exposedName); }

  const buckets = new Map<string, CollapseCandidate[]>();
  for (const c of candidates) {
    if (c.kind === 'unknown' || c.overridden) continue;
    const id = `${c.kind}\u0000${c.tool.name}`;
    const list = buckets.get(id);
    if (list) list.push(c); else buckets.set(id, [c]);
  }

  for (const [id, bucket] of [...buckets.entries()].sort(([a], [b]) => byCode(a, b))) {
    if (bucket.length < 2) continue;
    const [kind, toolName] = id.split('\u0000');
    const name = `${kindPrefix(kind)}${separator}${toolName}`;

    const splits = new Map<string, CollapseCandidate[]>();
    for (const c of bucket) {
      const fp = fingerprint(c.tool);
      const list = splits.get(fp);
      if (list) list.push(c); else splits.set(fp, [c]);
    }
    // Largest split wins; ties go to the split holding the alphabetically first backend.
    const firstBackend = (l: CollapseCandidate[]) => l.map(c => c.backend).sort(byCode)[0];
    const best = [...splits.values()].sort((a, b) =>
      b.length - a.length || byCode(firstBackend(a), firstBackend(b)))[0];
    if (best.length < 2) continue;

    const schema: any = best[0].tool.inputSchema;
    if (schema?.properties && Object.prototype.hasOwnProperty.call(schema.properties, HOST_PARAM)) {
      plan.warnings.push(`${name}: not collapsed, its schema already has a "${HOST_PARAM}" property`);
      continue;
    }
    if (taken.has(name)) {
      plan.warnings.push(`${name}: not collapsed, a tool with that name already exists`);
      continue;
    }
    if (splits.size > 1) {
      const left = bucket.filter(c => !best.includes(c)).map(c => c.backend).sort(byCode);
      plan.warnings.push(`${name}: ${left.join(', ')} differ${left.length === 1 ? 's' : ''} from the other ${best.length} host(s) and stay${left.length === 1 ? 's' : ''} separate`);
    }

    const members = new Map<string, string>();
    for (const c of [...best].sort((a, b) => byCode(a.backend, b.backend))) {
      members.set(c.backend, c.key);
      plan.memberOf.set(c.key, name);
    }
    taken.add(name);
    plan.tools.set(name, { name, toolName, template: best[0].tool, members });
  }
  return plan;
}

/**
 * The collapsed tool as one caller sees it: `host` limited to `hosts` (the
 * members this caller may use), added first and required. title, annotations
 * and outputSchema are passed through from the members (identical by the
 * fingerprint), as tools/list does for a per-host tool.
 */
export function renderCollapsedTool(ct: CollapsedTool, hosts: string[]): Tool {
  const schema: any = structuredClone(ct.template.inputSchema ?? { type: 'object' });
  schema.type = 'object';
  schema.properties = {
    [HOST_PARAM]: { type: 'string', enum: hosts, description: 'Host (gateway backend) to run this tool on' },
    ...(schema.properties ?? {}),
  };
  schema.required = [HOST_PARAM, ...(Array.isArray(schema.required) ? schema.required : [])];
  const base = ct.template.description ? `${ct.template.description}\n\n` : '';
  return {
    name: ct.name,
    description: `${base}Available on several hosts: choose one with "${HOST_PARAM}".`,
    inputSchema: schema,
    ...(ct.template.title !== undefined ? { title: ct.template.title } : {}),
    ...(ct.template.annotations !== undefined ? { annotations: structuredClone(ct.template.annotations) } : {}),
    ...(ct.template.outputSchema !== undefined ? { outputSchema: structuredClone(ct.template.outputSchema) } : {}),
  };
}

export type CollapsedCall =
  | { kind: 'none' }
  | { kind: 'route'; key: string; backend: string; args: Record<string, unknown> }
  | { kind: 'bad-host'; tool: CollapsedTool; host: unknown };

/**
 * Resolve a tools/call name against the plan. `route` carries the real
 * qualified key and the arguments without `host`; `bad-host` means the name
 * is collapsed but `host` is missing or not one of its members.
 */
export function resolveCollapsedCall(plan: CollapsePlan, name: string, args: Record<string, unknown> | undefined): CollapsedCall {
  const ct = plan.tools.get(name);
  if (!ct) return { kind: 'none' };
  const { [HOST_PARAM]: host, ...rest } = args ?? {};
  const key = typeof host === 'string' ? ct.members.get(host) : undefined;
  if (!key) return { kind: 'bad-host', tool: ct, host };
  return { kind: 'route', key, backend: host as string, args: rest };
}
