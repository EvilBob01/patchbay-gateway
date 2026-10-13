// Per-backend lazy tool loading: a backend flagged `"lazy": true` in
// mcp_server.json is published as one small meta-tool instead of its real
// tools, until a session asks for it. Four fixed gateway tools serve every lazy
// backend at once.
//
// Why: clients like Claude Desktop and ChatGPT put every tool definition in
// front of the model in every conversation. A backend most sessions never touch
// still costs its whole tool list each time.
//
//   <backend><sep>activate     adds the backend's real tools to THIS session's
//                              tools/list and sends notifications/tools/list_changed,
//                              so the client re-fetches and they become first-class
//                              (own names, schemas, annotations, per-tool approval).
//   patchbay<sep>search_tools  BM25 search over every tool the caller may use, lazy
//                              or not (tool-search.ts). Fixed cost, however many
//                              backends there are.
//   patchbay<sep>describe_tool one tool's full description and input schema.
//   patchbay<sep>call_read     call a read tool by `backend/tool`.
//   patchbay<sep>call_write    call any other tool by `backend/tool`.
//
// call_read / call_write are the fallback for clients that ignore list_changed.
// They are split so a client that approves per tool name can auto-approve reads
// and still prompt for writes. The class comes from the tool policy's
// "toolClass" section and the backend's readOnlyHint; unknown is write
// (policy.ts classifyTool). call_read refuses a write tool.
//
// Presentation and routing only. A call is rewritten to the real backend tool
// and goes through the same path as a direct call, so authorization, trifecta,
// rate limits, audit and result shaping all see the real backend/tool. What a
// caller may not use is never listed, counted, searched, described or activated.
//
// Activation is per MCP session (held by the per-session Server instance in
// mcp-proxy.ts), never global, and lasts until the session ends.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TransportConfig } from './config.js';
import type { ToolClass } from './policy.js';

/** Prefix of the gateway's own meta-tools. */
export const GATEWAY_PREFIX = 'patchbay';
export type GatewayAction = 'search_tools' | 'describe_tool' | 'call_read' | 'call_write';
export const GATEWAY_ACTIONS: readonly GatewayAction[] = ['search_tools', 'describe_tool', 'call_read', 'call_write'];

/** search_tools: default and maximum hit counts, and the hard ceiling with ties. */
export const SEARCH_DEFAULT_K = 5;
export const SEARCH_MAX_K = 15;
export const SEARCH_TIE_CEILING = 25;

/** A backend's config entry asks for lazy loading. */
export const isLazyConfig = (conf: TransportConfig | undefined): boolean =>
  conf?.lazy === true || String(conf?.lazy).toLowerCase() === 'true';

export interface LazyIndex {
  /** Lazy backend name -> its config one-liner (may be empty). */
  backends: Map<string, string>;
  /** `<backend><sep>activate` -> backend. */
  activate: Map<string, string>;
  /** `patchbay<sep><action>` -> action. Empty when there are no lazy backends. */
  gateway: Map<string, GatewayAction>;
  /** Real tool names that clash with a meta-tool name. */
  warnings: string[];
}

export const gatewayToolName = (action: GatewayAction, separator: string) => `${GATEWAY_PREFIX}${separator}${action}`;

/**
 * Index the lazy backends among the active ones. `toolKeys` are the qualified
 * names of every enabled tool, used only to warn about name clashes: a
 * meta-tool name wins, and the clashing real tool stays reachable through
 * call_read / call_write.
 */
export function buildLazyIndex(active: Record<string, TransportConfig>, separator: string, toolKeys: Iterable<string>): LazyIndex {
  const index: LazyIndex = { backends: new Map(), activate: new Map(), gateway: new Map(), warnings: [] };
  for (const [backend, conf] of Object.entries(active)) {
    if (!isLazyConfig(conf)) continue;
    const description = typeof conf.description === 'string' ? conf.description.trim() : '';
    index.backends.set(backend, description);
    index.activate.set(`${backend}${separator}activate`, backend);
  }
  if (index.backends.size) {
    for (const action of GATEWAY_ACTIONS) index.gateway.set(gatewayToolName(action, separator), action);
  }
  for (const key of toolKeys) {
    if (index.activate.has(key) || index.gateway.has(key)) {
      index.warnings.push(`${key}: the real tool is hidden behind the gateway meta-tool of the same name; reach it with ${gatewayToolName('call_write', separator)}`);
    }
  }
  return index;
}

/** True when `name` is one of the meta-tools (activate or gateway). */
export const isMetaName = (index: LazyIndex, name: string) => index.activate.has(name) || index.gateway.has(name);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A lazy backend's activate tool as one caller sees it. `count` is the number
 * of the backend's tools this caller may use (never zero: a backend with
 * nothing allowed is not listed at all).
 */
export function renderActivateTool(backend: string, oneLiner: string, count: number, separator: string): Tool {
  const about = oneLiner || `Tools from the "${backend}" backend.`;
  const head = `[${backend}] ${about.replace(/\s*$/, '')}${/[.!?]$/.test(about.trim()) ? '' : '.'}`;
  return {
    name: `${backend}${separator}activate`,
    description: `${head} ${plural(count, 'tool')} available, not loaded yet. Call this (no arguments) to add them to your tool list ` +
      `under their own names, then call them directly; best when you will use this backend a lot. For one or two calls, ` +
      `${gatewayToolName('search_tools', separator)} and ${gatewayToolName('call_read', separator)} / ${gatewayToolName('call_write', separator)} ` +
      `leave your tool list unchanged, and also work if loaded tools don't appear.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: `Load ${backend} tools`, readOnlyHint: true, openWorldHint: false },
  };
}

/** The four gateway meta-tools. `lazyBackends`/`lazyTools`: what this caller can reach lazily. */
export function renderGatewayTools(separator: string, lazyBackends: number, lazyTools: number): Tool[] {
  const n = (a: GatewayAction) => gatewayToolName(a, separator);
  const ref = { type: 'string', description: 'The tool as search_tools returns it: "<backend>/<tool>".' };
  // Explicitly open: grammar-constrained decoders (llama.cpp-style local
  // models) read an object with no properties as closed and can only emit {}.
  const OPEN_ARGUMENTS = { type: 'object', additionalProperties: true, description: "The tool's arguments, per its input schema (see describe_tool)." };
  return [
    {
      name: n('search_tools'),
      description: `Search every tool on this gateway that you may use` +
        (lazyTools ? `, including ${plural(lazyTools, 'tool')} on ${plural(lazyBackends, 'backend')} that are not loaded yet` : '') +
        `. Returns the best matches with a one-line summary, ` +
        `read/write class and how to use each. Use this first when you need a tool you don't see.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to do, in a few words (e.g. "list virtual machines").' },
          backend: { type: 'string', description: 'Only search this backend. With an empty query, lists its tools.' },
          limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_K, description: `How many hits (default ${SEARCH_DEFAULT_K}).` },
        },
      },
      annotations: { title: 'Search tools', readOnlyHint: true, openWorldHint: false },
    },
    {
      name: n('describe_tool'),
      description: `Full description and input schema of one tool from ${n('search_tools')}, to call it with ` +
        `${n('call_read')} or ${n('call_write')}.`,
      inputSchema: { type: 'object', properties: { tool: ref }, required: ['tool'] },
      annotations: { title: 'Describe a tool', readOnlyHint: true, openWorldHint: false },
    },
    {
      name: n('call_read'),
      description: `Run a READ tool (class "read" in ${n('search_tools')}) by name: {"tool": "<backend>/<tool>", "arguments": {...}}. ` +
        `Refuses write tools; use ${n('call_write')} for those. Same permissions and checks as calling the tool directly.`,
      inputSchema: {
        type: 'object',
        properties: { tool: ref, arguments: OPEN_ARGUMENTS },
        required: ['tool'],
      },
      annotations: { title: 'Run a read-only tool', readOnlyHint: true },
    },
    {
      name: n('call_write'),
      description: `Run any tool, including ones that change things (class "write" in ${n('search_tools')}), by name: ` +
        `{"tool": "<backend>/<tool>", "arguments": {...}}. Same permissions and checks as calling the tool directly.`,
      inputSchema: {
        type: 'object',
        properties: { tool: ref, arguments: OPEN_ARGUMENTS },
        required: ['tool'],
      },
      annotations: { title: 'Run a tool that may change things', readOnlyHint: false, destructiveHint: true },
    },
  ];
}

export function activateText(backend: string, published: string[], separator: string): string {
  return `Loaded ${plural(published.length, 'tool')} from ${backend}; they are now in your tool list:\n` +
    published.map(n => `- ${n}`).join('\n') +
    `\n\nIf your client doesn't show them, run them with ${gatewayToolName('call_read', separator)} / ` +
    `${gatewayToolName('call_write', separator)} {"tool": "${backend}/<tool>", ...} instead.`;
}

/** One search hit, as returned to the model. */
export interface SearchHit {
  /** `backend/tool`: what describe_tool / call_read / call_write take. */
  tool: string;
  summary: string;
  class: ToolClass;
  score: number;
  /** How to use it from here. */
  use: string;
}

export function searchText(query: string, hits: SearchHit[], truncatedTo: number | undefined): string {
  if (!hits.length) return `No tools match "${query}". Try other words, or search_tools with "backend" set to list one backend.`;
  return JSON.stringify({
    query,
    hits,
    ...(truncatedTo !== undefined ? { note: `more matches exist; showing ${truncatedTo}` } : {}),
  }, null, 1);
}

export function describeText(ref: string, tool: Tool, toolClass: ToolClass, use: string): string {
  return JSON.stringify({
    tool: ref,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: tool.description ?? '',
    class: toolClass,
    inputSchema: tool.inputSchema,
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    use,
  }, null, 2);
}
