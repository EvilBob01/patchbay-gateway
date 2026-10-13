import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js"; // Import the constant
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool,
  ListToolsResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ResourceTemplate,
  Prompt,
  Resource,
  CompatibilityCallToolResultSchema,
  GetPromptResultSchema,
  ProgressNotificationSchema,
  ToolListChangedNotificationSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from 'crypto';
import { gatewayError, bareError, stripMcpPrefix } from './mcpErrors.js';
import { createClients, ConnectedClient, reconnectSingleClient } from './client.js';
import { logger } from './logger.js';
import { configPath } from './paths.js';
import { Config, loadConfig, TransportConfig, isSSEConfig, isStdioConfig, isHttpConfig, ToolConfig, loadToolConfig, DEFAULT_SERVER_TOOLNAME_SEPERATOR } from './config.js';
import * as eventsource from 'eventsource';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { recordToolCall, recordRateLimit, recordToolPinEvent, recordBackendEvent } from './audit.js';
import { BackendSupervisor, BACKEND_UNAVAILABLE_CODE, unavailableMessage, type BackendStatus, type BackendTransition } from './backendHealth.js';
import { ToolPinStore, PIN_TOOLS_ENABLED, PIN_NEW_BACKENDS, TOOL_PINS_PATH, TOOL_PENDING_REVIEW_CODE, hashDefinition, type PinEvent, type PinSnapshot } from './toolPins.js';
import { UNKNOWN_IDENTITY, type CallerIdentity } from './identity.js';
import { currentPolicy, AUTHZ_DENIED_CODE, type AuthzDecision } from './policy.js';
import { checkTrifecta, configureTrifecta, summarizeClassification, selfCompletingTools, backendKind, TRIFECTA_BLOCKED_CODE, type TrifectaDecision, type TrifectaConfig } from './trifecta.js';
import { buildCollapsePlan, renderCollapsedTool, resolveCollapsedCall, shouldCollapseTools, HOST_PARAM, type CollapsePlan } from './collapse.js';
import { shapeToolResult } from './tool-result.js';
import { buildLazyIndex, renderActivateTool, renderGatewayTools, activateText, searchText, describeText, isMetaName, gatewayToolName,
  SEARCH_DEFAULT_K, SEARCH_MAX_K, SEARCH_TIE_CEILING, type LazyIndex, type GatewayAction, type SearchHit } from './lazy.js';
import { toolTokens, rankBM25, firstSentence } from './tool-search.js';
import type { CompiledPolicy } from './policy.js';
import { RATE_LIMIT_ENABLED, RATE_LIMITED_CODE, TOOL_CALL_LIMIT, toolCallLimiter, rateKey, rateLimitErrorData, rateLimitMessage } from './ratelimit.js';
import { VERSION } from './version.js';

global.EventSource = eventsource.EventSource;

// --- Caller identity, keyed by MCP transport session id -------------------
//
// sse.ts resolves the credential on each request and registers the resulting
// identity here against the transport's session id; request handlers read it
// back out of `extra.sessionId`.
//
// This is only sound because each client session gets its own Server instance
// (see buildServerInstance). Before that, `extra.sessionId` was derived from a
// single shared `_transport`, so this lookup would have resolved every caller
// to whichever session connected last -- i.e. it would have attributed calls to
// the wrong user. Do not reintroduce a shared server.
const sessionIdentities = new Map<string, CallerIdentity>();

export const setSessionIdentity = (sessionId: string, identity: CallerIdentity): void => {
  sessionIdentities.set(sessionId, identity);
};

/** Identity bound to a session, if any. Used by sse.ts for the legacy /message route. */
export const getSessionIdentity = (sessionId: string): CallerIdentity | undefined => sessionIdentities.get(sessionId);

export const clearSessionIdentity = (sessionId: string): void => {
  sessionIdentities.delete(sessionId);
};

/**
 * Identity of the caller behind a request. Falls back to the explicit
 * UNKNOWN_IDENTITY rather than undefined, so the audit trail can never record a
 * null caller or crash trying to read one.
 */
const identityFor = (extra: any): CallerIdentity => {
  const sid = extra?.sessionId as string | undefined;
  return (sid && sessionIdentities.get(sid)) || UNKNOWN_IDENTITY;
};

const __mcpProxyDirname = path.dirname(fileURLToPath(import.meta.url));
// Cosmetic admin-UI layout, reused here as the canonical tool ordering.
const UI_LAYOUT_PATH = configPath('ui_layout.json');

/**
 * Build a rank map (toolKey -> position) from the admin UI's saved Tools layout.
 * Tools are emitted from tools/list in this order, which (a) lets the admin control
 * how tools are presented to clients from the Tools tab, and (b) keeps the ordering
 * STABLE across restarts. Without this, order follows backend connection order --
 * which varies run to run and needlessly busts LLM prompt caches.
 * Anything not in the layout (or if no layout exists) falls back to alphabetical.
 */
async function loadToolOrderRanks(): Promise<Map<string, number>> {
  const ranks = new Map<string, number>();
  try {
    const layout = JSON.parse(await readFile(UI_LAYOUT_PATH, 'utf-8'));
    const page = layout?.tools;
    if (!page) return ranks;
    let i = 0;
    for (const g of (Array.isArray(page.groups) ? page.groups : [])) {
      for (const k of (Array.isArray(g?.keys) ? g.keys : [])) {
        if (typeof k === 'string' && !ranks.has(k)) ranks.set(k, i++);
      }
    }
    for (const k of (Array.isArray(page.ungrouped) ? page.ungrouped : [])) {
      if (typeof k === 'string' && !ranks.has(k)) ranks.set(k, i++);
    }
  } catch {
    // No layout saved yet (or unreadable) -- alphabetical fallback still applies.
  }
  return ranks;
}

// --- Shared State ---
// Keep track of connected clients and the maps globally within this module
let currentConnectedClients: ConnectedClient[] = [];
const toolToClientMap = new Map<string, { client: ConnectedClient, toolInfo: Tool }>(); // Store full tool info
const resourceToClientMap = new Map<string, ConnectedClient>();
const promptToClientMap = new Map<string, ConnectedClient>();
let currentToolConfig: ToolConfig = { tools: {} }; // Store loaded tool config
let currentActiveServersConfig: Record<string, TransportConfig> = {}; // Added for retry logic
let currentSeparator: string = DEFAULT_SERVER_TOOLNAME_SEPERATOR; // Store the current separator
// Bumped whenever toolToClientMap is rebuilt or a backend's entries change, so
// the collapse plan (collapse.ts) is recomputed after any reload or reconnect.
let toolMapVersion = 0;
let collapseCache: { version: number; trifecta: TrifectaConfig; separator: string; plan: CollapsePlan } | undefined;
let lazyCache: { version: number; separator: string; index: LazyIndex } | undefined;

// Rug-pull protection (toolPins.ts). Undefined when MCP_PIN_TOOLS=false.
const toolPins: ToolPinStore | undefined = PIN_TOOLS_ENABLED
    ? new ToolPinStore({ path: TOOL_PINS_PATH, mode: PIN_NEW_BACKENDS })
    : undefined;
if (toolPins) {
    toolPins.load();
    if (toolPins.failClosedError) logger.error(`Tool pins: ${toolPins.failClosedError}`);
}

// Live protocol servers, one per client session, so a change to the approved
// tool set can be announced with tools/list_changed.
const liveServers = new Set<Server>();

function announceToolListChanged(): void {
    for (const s of liveServers) s.sendToolListChanged().catch(() => { /* session gone or not initialised */ });
}

// --- Backend crash recovery (backendHealth.ts) ------------------------------
//
// Every backend connection is watched (watchClient): when a stdio child exits
// or a transport closes, the supervisor marks the backend down and reconnects
// it with backoff through connectBackend -- the same path an admin reconnect
// and a reload take, so tools always come back through the tool pins.
// A down backend's last-known tools stay listed; calls to them get
// BACKEND_UNAVAILABLE_CODE (backendUnavailableError) instead of a retry storm.

// Clients the gateway closes on purpose (reload, refresh, shutdown): their
// onclose is not a crash.
const retiring = new WeakSet<object>();
const backendStateListeners: ((s: BackendStatus) => void)[] = [];

function logBackendTransition(t: BackendTransition): void {
    switch (t.action) {
        case 'down':
            logger.warn(`Backend "${t.backend}" is DOWN (${t.reason}); reconnecting with backoff (${t.recentCrashes} crash(es) in the flap window).`);
            break;
        case 'connect-failed':
            logger.warn(`Backend "${t.backend}" could not be connected (${t.reason}); retrying with backoff.`);
            break;
        case 'reconnected':
            logger.log(`Backend "${t.backend}" reconnected after ${t.attempts} attempt(s); it was down ${(t.downMs / 1000).toFixed(1)}s.`);
            break;
        case 'failed':
            logger.error(`Backend "${t.backend}" FAILED: it went down ${t.recentCrashes} times within ${t.windowMin} min, so automatic reconnects have STOPPED. ` +
                `Its tools return an error until an admin reconnects it (Servers tab, or POST /admin/server/reconnect/${t.backend}) or reloads the config. Last error: ${t.reason}`);
            break;
        case 'admin-reconnect':
            logger.log(`Backend "${t.backend}": admin reconnect by ${t.admin} ${t.ok ? 'succeeded' : `failed: ${t.error}`}.`);
            break;
    }
}

const backendHealth = new BackendSupervisor({
    reconnect: (backend, stillWanted) => reconnectBackend(backend, stillWanted),
    alive: (backend) => isConnected(currentConnectedClients.find(c => c.name === backend)),
    onTransition: (t, status) => {
        logBackendTransition(t);
        recordBackendEvent(t);
        for (const fn of backendStateListeners) {
            try { fn(status); } catch { /* a listener's own problem */ }
        }
    },
});

// --- Connection locks --------------------------------------------------------
//
// Everything that opens or closes a backend's connection holds that backend's
// lock: automatic recovery and the admin reconnect (both through
// connectBackend), the SSE per-call refresh and the mailbox editor
// (refreshBackendConnection), the tool-pin re-list, and a reload, which holds
// the locks of every backend it may touch for its whole run. Two of them can
// therefore never each spawn a connection and install one over the other
// without retiring it (a leaked child process). Tool calls do not take it.
const backendLocks = new Map<string, Promise<void>>();
// Serialises reloads. Not a valid backend key, so it never meets a real one.
const RELOAD_LOCK = '\u0000reload';

async function withBackendLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = backendLocks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const tail = prev.then(() => new Promise<void>(r => { release = r; }));
    backendLocks.set(name, tail);
    await prev;
    try {
        return await fn();
    } finally {
        release();
        if (backendLocks.get(name) === tail) backendLocks.delete(name);
    }
}

/** Several backends' locks, taken in sorted order, so two holders never deadlock. */
function withBackendLocks<T>(names: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(names)].sort();
    const take = (i: number): Promise<T> => i === sorted.length ? fn() : withBackendLock(sorted[i], () => take(i + 1));
    return take(0);
}

/** Close a client on purpose, so its onclose is not taken for a crash. */
async function retire(c: ConnectedClient): Promise<void> {
    retiring.add(c.client);
    await c.cleanup();
}

/** Report this client's backend down when its transport closes on its own. */
function watchClient(cc: ConnectedClient): void {
    const c = cc.client;
    c.onclose = () => {
        if (retiring.has(c)) return;
        // Only the backend's current connection counts; a replaced one is history.
        if (currentConnectedClients.find(x => x.name === cc.name) !== cc) return;
        backendHealth.reportDown(cc.name, cc.transportType === 'stdio' ? 'stdio process exited' : `${cc.transportType} transport closed`);
    };
    c.onerror = (e: any) => { logger.debug(`Backend "${cc.name}" transport error: ${e?.message || e}`); };
}

/** Is this client's transport still open? (The SDK drops it on close.) */
const isConnected = (c: ConnectedClient | undefined): boolean => !!c && c.client.transport !== undefined;

/**
 * Mark a just-connected backend up -- or down at once, if it already exited
 * before watchClient was attached (its close would otherwise go unnoticed).
 */
function markConnected(c: ConnectedClient): void {
    backendHealth.markUp(c.name);
    if (!isConnected(c)) backendHealth.reportDown(c.name, 'exited right after connecting');
}

/** Clients whose backend is up: the ones worth sending a request to. */
const liveClients = (): ConnectedClient[] => currentConnectedClients.filter(c => backendHealth.isUp(c.name));

/** The error for a call to a backend that is down or failed; undefined while it is up. */
function backendUnavailableError(backend: string): McpError | undefined {
    if (backendHealth.isUp(backend)) return undefined;
    const s = backendHealth.status(backend)!;
    return gatewayError(BACKEND_UNAVAILABLE_CODE, unavailableMessage(s, Math.round(backendHealth.settings.flapWindowMs / 60_000)),
        { backendUnavailable: { backend, state: s.state, since: s.since, attempt: s.attempt, ...(s.nextRetryAt ? { nextRetryAt: s.nextRetryAt } : {}) } });
}

/** One backend's served tools, as a string that changes when any of them does. */
function backendToolSignature(backend: string): string {
    const entries = [...toolToClientMap.entries()].filter(([, v]) => v.client.name === backend)
        .map(([k, v]) => [k, v.toolInfo] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return JSON.stringify(entries);
}

/**
 * (Re)connect one backend and load its tools through the pins. Throws on
 * failure, and then leaves its last-known tools in the map (stable tool lists).
 * `checkStale`: give up if the backend's config changed while connecting.
 * `stillWanted`: the supervisor's check that its attempt is not stale.
 * Runs under the backend's connection lock, so a fresh connection never
 * replaces another one without retiring it.
 */
async function connectBackend(serverKey: string, cfg: TransportConfig, checkStale: boolean, stillWanted?: () => boolean): Promise<void> {
  await withBackendLock(serverKey, async () => {
    // Checked once the lock is ours: whoever held it may have removed the
    // backend, changed its config or reconnected it already.
    if (stillWanted && !stillWanted()) throw new Error(`the reconnect of "${serverKey}" was superseded`);
    if (!currentActiveServersConfig[serverKey]) throw new Error(`backend "${serverKey}" is no longer configured`);
    if (checkStale && stableConfigString(currentActiveServersConfig[serverKey]) !== stableConfigString(cfg)) {
        throw new Error(`the configuration of "${serverKey}" changed while it was reconnecting`);
    }
    const old = currentConnectedClients.find(c => c.name === serverKey);
    const parts = await reconnectSingleClient(serverKey, cfg, old ? () => retire(old) : undefined);
    const fresh: ConnectedClient = { ...parts, name: serverKey };
    if (!currentActiveServersConfig[serverKey]
        || (checkStale && stableConfigString(currentActiveServersConfig[serverKey]) !== stableConfigString(cfg))) {
        await retire(fresh).catch(() => {});
        throw new Error(`the configuration of "${serverKey}" changed while it was reconnecting`);
    }
    const before = backendToolSignature(serverKey);
    if (!(await loadBackendTools(fresh))) {
        await retire(fresh).catch(() => {});
        throw new Error(`tools/list failed on "${serverKey}" after connecting`);
    }
    const i = currentConnectedClients.findIndex(c => c.name === serverKey);
    if (i !== -1) {
        // Under the lock this is `old`, already retired; anything else would leak.
        const current = currentConnectedClients[i];
        if (current !== old) await retire(current).catch(() => {});
        currentConnectedClients[i] = fresh;
    } else {
        currentConnectedClients.push(fresh);
    }
    watchClient(fresh);

    for (const [key, value] of resourceToClientMap.entries()) if (value.name === serverKey) resourceToClientMap.delete(key);
    for (const [key, value] of promptToClientMap.entries()) if (value.name === serverKey) promptToClientMap.delete(key);
    try {
        const result = await fresh.client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema);
        result.resources?.forEach(resource => resourceToClientMap.set(resource.uri, fresh));
    } catch (error: any) {
        if (!(error?.name === 'McpError' && error?.code === -32601)) {
            logger.error(`Error fetching resources from ${serverKey} after connecting:`, error?.message || error);
        }
    }
    try {
        const result = await fresh.client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema);
        result.prompts?.forEach(prompt => promptToClientMap.set(prompt.name, fresh));
    } catch (error: any) {
        if (!(error?.name === 'McpError' && error?.code === -32601)) {
            logger.error(`Error fetching prompts from ${serverKey} after connecting:`, error?.message || error);
        }
    }
    toolPins?.endBaseline();
    // Map entries now point at the new client: rebuild the collapse/lazy/search caches.
    toolMapVersion++;
    // Same tools as before the crash: no tools/list_changed, so client tool lists stay put.
    if (backendToolSignature(serverKey) !== before) announceToolListChanged();
  });
}

/** The supervisor's reconnect: the backend's current config, or an error if it was removed. */
async function reconnectBackend(serverKey: string, stillWanted?: () => boolean): Promise<void> {
    const cfg = currentActiveServersConfig[serverKey];
    if (!cfg) throw new Error(`backend "${serverKey}" is no longer configured`);
    await connectBackend(serverKey, cfg, true, stillWanted);
}

/** Per-backend state for the admin API (GET /admin/server/status). */
export function getBackendStatus() {
    const now = new Date().toISOString();
    const backends = Object.keys(currentActiveServersConfig).sort().map(name => {
        const s = backendHealth.status(name);
        const client = currentConnectedClients.find(c => c.name === name);
        let tools = 0;
        for (const v of toolToClientMap.values()) if (v.client.name === name) tools++;
        return {
            ...(s ?? { backend: name, state: client ? 'up' : 'reconnecting', since: now, attempt: 0, recentCrashes: 0 }),
            transport: client?.transportType ?? (currentActiveServersConfig[name] as any).type ?? null,
            tools,
        };
    });
    const { baseMs, maxMs, flapMax, flapWindowMs, maxConcurrent } = backendHealth.settings;
    return {
        backends,
        settings: { reconnectBaseMs: baseMs, reconnectMaxMs: maxMs, flapMax, flapWindowMin: Math.round(flapWindowMs / 60_000), reconnectConcurrency: maxConcurrent },
    };
}

/** Admin "reconnect this backend": now, whatever its state; clears its flap history. */
export async function reconnectBackendNow(serverKey: string, admin: string): Promise<BackendStatus> {
    const notActive = () => Object.assign(new Error(`No active backend "${serverKey}".`), { status: 404 });
    if (!currentActiveServersConfig[serverKey]) throw notActive();
    const status = await backendHealth.reconnectNow(serverKey, admin);
    // A reload removed it while the reconnect waited.
    if (!status || !currentActiveServersConfig[serverKey]) throw notActive();
    return status;
}

export function onBackendStateChanged(fn: (s: BackendStatus) => void): void {
    backendStateListeners.push(fn);
}

function logPinEvents(events: PinEvent[]): void {
    for (const e of events) {
        recordToolPinEvent(e);
        if (e.event === 'held') {
            logger.warn(`Tool pins: ${e.backend}/${e.tool} withheld pending admin review (${e.reason}${e.oldHash ? `, was ${e.oldHash.slice(0, 12)}` : ''}, now ${e.newHash?.slice(0, 12)}).`);
        } else if (e.event !== 'baseline') {
            logger.log(`Tool pins: ${e.backend}/${e.tool} ${e.event}${e.admin ? ` by ${e.admin}` : ''}.`);
        }
    }
    const baseline = events.filter(e => e.event === 'baseline').length;
    if (baseline) logger.log(`Tool pins: pinned ${baseline} tool(s) of ${events[0].backend} as the baseline.`);
}

/**
 * The lazy backends (lazy.ts) among the active ones, and their meta-tool names.
 * Rebuilt when the tool map or separator changes; a config reload goes through
 * updateBackendConnections, which bumps toolMapVersion.
 */
function currentLazyIndex(): LazyIndex {
    if (lazyCache && lazyCache.version === toolMapVersion && lazyCache.separator === currentSeparator) {
        return lazyCache.index;
    }
    const index = buildLazyIndex(currentActiveServersConfig, currentSeparator, toolToClientMap.keys());
    if (index.backends.size) logger.log(`Lazy backends: ${[...index.backends.keys()].join(', ')}.`);
    for (const w of index.warnings) logger.warn(`Lazy backends: ${w}`);
    lazyCache = { version: toolMapVersion, separator: currentSeparator, index };
    return index;
}

/**
 * THE visibility check: may this caller see and use this backend tool? Every
 * listing, count, search, describe and activation goes through here, so a
 * later condition (e.g. "definition approved", for rug-pull protection) is
 * added in one place. tools/call re-checks authorization in forwardToolCall.
 */
function mayUse(policy: CompiledPolicy, identity: CallerIdentity, backend: string, tool: string): boolean {
    return !policy.configured || policy.decide({ identity, backend, tool }).allowed;
}

// --- Progress relay ---------------------------------------------------------
//
// A backend's notifications/progress for a forwarded tools/call is routed here
// by the gateway's own progress token and relayed to the calling client under
// the client's token. Not the SDK's request(onprogress): its Protocol runs
// notification handlers on a microtask but handles a response synchronously and
// drops the progress callback there, so a backend's last progress update that
// arrives in the same chunk as its result was lost as "unknown token". Routes
// are removed only after already-queued notifications have run (setImmediate).
const progressRoutes = new Map<string, (p: { progress: number; total?: number; message?: string }) => void>();
const progressRouted = new WeakSet<object>();

function routeBackendProgress(client: ConnectedClient['client']): void {
    if (progressRouted.has(client)) return;
    progressRouted.add(client);
    client.setNotificationHandler(ProgressNotificationSchema, (n) => {
        const { progressToken, ...p } = n.params as any;
        progressRoutes.get(String(progressToken))?.(p);
    });
}

let searchTokenCache: { version: number; tokens: Map<string, string[]> } | undefined;

/** search_tools tokens per qualified key, rebuilt whenever the tool map changes. */
function searchTokensFor(key: string, backend: string, tool: Tool): string[] {
    if (!searchTokenCache || searchTokenCache.version !== toolMapVersion) {
        searchTokenCache = { version: toolMapVersion, tokens: new Map() };
    }
    let t = searchTokenCache.tokens.get(key);
    if (!t) {
        t = toolTokens(backend, currentLazyIndex().backends.get(backend) ?? '', tool);
        searchTokenCache.tokens.set(key, t);
    }
    return t;
}

/**
 * The collapse plan for the current tool map. Rebuilt lazily when the map, the
 * separator or the policy's trifecta section (backendKinds) has changed.
 */
function currentCollapsePlan(trifectaCfg: TrifectaConfig): CollapsePlan {
    if (collapseCache && collapseCache.version === toolMapVersion && collapseCache.trifecta === trifectaCfg
        && collapseCache.separator === currentSeparator) {
        return collapseCache.plan;
    }
    const overrides = currentToolConfig.tools || {};
    // Lazy backends never collapse: behind their meta-tools there is nothing to
    // save, and once activated their tools must keep their own names.
    const lazy = currentLazyIndex();
    const candidates = Array.from(toolToClientMap.entries()).filter(([, { client }]) => !lazy.backends.has(client.name)).map(([key, { client, toolInfo }]) => ({
        key,
        backend: client.name,
        tool: toolInfo,
        kind: backendKind(client.name, trifectaCfg),
        exposedName: overrides[key]?.exposedName || key,
        overridden: !!(overrides[key]?.exposedName || overrides[key]?.exposedDescription),
    }));
    const plan = buildCollapsePlan(candidates, currentSeparator);
    logger.log(`Tool collapsing: ${plan.tools.size} collapsed tool(s) covering ${plan.memberOf.size} backend tools.`);
    for (const w of plan.warnings) logger.warn(`Tool collapsing: ${w}`);
    collapseCache = { version: toolMapVersion, trifecta: trifectaCfg, separator: currentSeparator, plan };
    return plan;
}

// Define Global Default Proxy Settings
const defaultProxySettingsFull: Required<NonNullable<Config['proxy']>> = {
    retrySseToolCall: true, // Renamed from retrySseToolCallOnDisconnect
    sseToolCallMaxRetries: 2,
    sseToolCallRetryDelayBaseMs: 300,
    retryHttpToolCall: true,
    httpToolCallMaxRetries: 2,
    httpToolCallRetryDelayBaseMs: 300,
    retryStdioToolCall: true,
    stdioToolCallMaxRetries: 2,
    stdioToolCallRetryDelayBaseMs: 300,
};

let currentProxyConfig: Required<NonNullable<Config['proxy']>> = { ...defaultProxySettingsFull }; // Initialize with full defaults

/**
 * Serialise a server config with object keys sorted at every level, so two
 * configs that differ only in key order (e.g. re-saved by the admin UI) compare
 * equal. Array order is preserved -- `args` order is significant.
 */
const stableConfigString = (value: unknown): string =>
    JSON.stringify(value, (_key, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
            : v);

// --- Function to update backend connections and maps ---
const listChangedHooked = new WeakSet<object>();

/**
 * THE way backend tools enter toolToClientMap: fetch the backend's tools/list,
 * drop tools disabled in tool_config.json, pass the rest through the tool pins
 * (toolPins.ts) and map only what is served. Replaces this backend's previous
 * entries. Returns false (and leaves the map alone) when tools/list failed, so
 * a backend that is down is not recorded as "all tools removed".
 */
async function loadBackendTools(connectedClient: ConnectedClient): Promise<boolean> {
    let tools: Tool[];
    try {
        const result = await connectedClient.client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
        tools = result.tools ?? [];
    } catch (error: any) {
        if (error?.name === 'McpError' && error?.code === -32601) {
            tools = []; // backend has no tools
        } else {
            logger.error(`Error fetching tools from ${connectedClient.name}:`, error?.message || error);
            return false;
        }
    }
    const enabled = tools.filter(tool => currentToolConfig.tools[`${connectedClient.name}${currentSeparator}${tool.name}`]?.enabled !== false);
    let served = enabled;
    if (toolPins) {
        const r = toolPins.admit(connectedClient.name, enabled);
        served = r.served;
        logPinEvents(r.events);
    }
    for (const [key, value] of toolToClientMap.entries()) {
        if (value.client.name === connectedClient.name) toolToClientMap.delete(key);
    }
    for (const tool of served) {
        toolToClientMap.set(`${connectedClient.name}${currentSeparator}${tool.name}`, { client: connectedClient, toolInfo: tool });
    }
    hookBackendListChanged(connectedClient);
    return true;
}

/**
 * A backend's own notifications/tools/list_changed re-lists that backend
 * (debounced), so a remote backend that changes a definition while connected
 * is caught without a reconnect.
 */
function hookBackendListChanged(connectedClient: ConnectedClient): void {
    if (listChangedHooked.has(connectedClient.client)) return;
    listChangedHooked.add(connectedClient.client);
    let timer: NodeJS.Timeout | undefined;
    connectedClient.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            recheckToolPins(connectedClient.name).catch(e => logger.error(`Re-check of ${connectedClient.name} failed: ${e?.message || e}`));
        }, 200);
        timer.unref?.();
    });
}

/**
 * Apply a (re)loaded config. One reload at a time, holding the connection lock
 * of every backend it may touch (configured before or after), so no reconnect
 * runs alongside it.
 */
export const updateBackendConnections = (newServerConfig: Config, newToolConfig: ToolConfig): Promise<void> =>
    withBackendLock(RELOAD_LOCK, () => {
        const names = [
            ...Object.keys(newServerConfig.mcpServers || {}),
            ...Object.keys(currentActiveServersConfig),
            ...currentConnectedClients.map(c => c.name),
            ...backendHealth.list().map(s => s.backend),
        ];
        return withBackendLocks(names, () => applyBackendConnections(newServerConfig, newToolConfig));
    });

async function applyBackendConnections(newServerConfig: Config, newToolConfig: ToolConfig): Promise<void> {
    logger.log("Starting update of backend connections...");
    currentToolConfig = newToolConfig; // Update stored tool config
    currentProxyConfig = { // Update currentProxyConfig using full defaults
        ...defaultProxySettingsFull,
        ...(newServerConfig.proxy || {}),
    };
    // Update the current separator from the new config
    currentSeparator = newServerConfig.serverToolnameSeparator || DEFAULT_SERVER_TOOLNAME_SEPERATOR;
    logger.log(`Using server toolname separator: "${currentSeparator}"`);

    const activeServersConfigLocal: Record<string, TransportConfig> = {}; // Renamed to avoid conflict with module-level
    for (const serverKey in newServerConfig.mcpServers) {
        if (Object.prototype.hasOwnProperty.call(newServerConfig.mcpServers, serverKey)) {
            const serverConf = newServerConfig.mcpServers[serverKey];
            const isActive = !(serverConf.active === false || String(serverConf.active).toLowerCase() === 'false');
            if (isActive) {
                activeServersConfigLocal[serverKey] = serverConf;
            } else {
                 const serverName = serverKey;
                 logger.log(`Skipping inactive server during update: ${serverName}`);
            }
        }
    }
    currentActiveServersConfig = activeServersConfigLocal; // Update module-level variable

    const newClientKeys = new Set(Object.keys(activeServersConfigLocal));
    const currentClientKeys = new Set(currentConnectedClients.map(c => c.name));

    // A server whose config was edited (command, args, env, url, ...) must be
    // torn down and reconnected, or the edit silently does nothing until restart.
    // So must one that is down or failed (backendHealth.ts): a reload is how an
    // admin revives it. Every other still-configured, healthy client is kept.
    const configChanged = (c: ConnectedClient) => stableConfigString(c.config) !== stableConfigString(activeServersConfigLocal[c.name]);
    const clientsToReplace = currentConnectedClients.filter(c =>
        newClientKeys.has(c.name) && (configChanged(c) || !backendHealth.isUp(c.name)));
    const replaceKeys = new Set(clientsToReplace.map(c => c.name));

    const clientsToRemove = currentConnectedClients.filter(c => !newClientKeys.has(c.name) || replaceKeys.has(c.name));
    const clientsToKeep = currentConnectedClients.filter(c => newClientKeys.has(c.name) && !replaceKeys.has(c.name));
    const keysToAdd = Object.keys(activeServersConfigLocal).filter(key => !currentClientKeys.has(key) || replaceKeys.has(key));

    logger.log(`Clients to replace (config changed): ${clientsToReplace.map(c => c.name).join(', ') || 'None'}`);
    logger.log(`Clients to remove: ${clientsToRemove.map(c => c.name).join(', ') || 'None'}`);
    logger.log(`Clients to keep: ${clientsToKeep.map(c => c.name).join(', ') || 'None'}`);
    logger.log(`Server keys to add: ${keysToAdd.join(', ') || 'None'}`);

    // Backends this reload connects stop retrying on their own (no second
    // connection racing this one); removed backends are forgotten. Not reset():
    // an attempt in flight may be waiting for a lock this reload holds.
    for (const key of keysToAdd) backendHealth.invalidate(key);
    for (const s of backendHealth.list()) {
        if (!newClientKeys.has(s.backend)) backendHealth.forget(s.backend);
    }

    // 1. Cleanup removed clients
    if (clientsToRemove.length > 0) {
        logger.log(`Cleaning up ${clientsToRemove.length} removed clients...`);
        await Promise.all(clientsToRemove.map(async (c) => {
            try {
                await retire(c);
                logger.log(`  Cleaned up client: ${c.name}`);
            } catch (error: any) {
                logger.error(`  Error cleaning up client ${c.name}: ${error.message}`);
            }
        }));
    }

    // 2. Connect new clients
    let newlyConnectedClients: ConnectedClient[] = [];
    const connectFailures = new Map<string, string>();
    if (keysToAdd.length > 0) {
        const configToAdd: Record<string, TransportConfig> = {};
        keysToAdd.forEach(key => { configToAdd[key] = activeServersConfigLocal[key]; });
        logger.log(`Connecting ${keysToAdd.length} new clients...`);
        newlyConnectedClients = await createClients(configToAdd, connectFailures);
        logger.log(`Successfully connected to ${newlyConnectedClients.length} out of ${keysToAdd.length} new clients.`);
    }

    // A backend that was down before this reload, still can't be connected and
    // whose config is unchanged keeps its old (closed) client as a placeholder,
    // so its last-known tools stay listed while it is retried.
    const connectedNames = new Set(newlyConnectedClients.map(c => c.name));
    const placeholders = clientsToReplace.filter(c => !connectedNames.has(c.name) && !configChanged(c));

    // 3. Update the main list
    currentConnectedClients = [...clientsToKeep, ...newlyConnectedClients, ...placeholders];
    logger.log(`Total active clients after update: ${currentConnectedClients.length}`);
    for (const c of newlyConnectedClients) {
        watchClient(c);
        markConnected(c);
    }
    for (const key of keysToAdd) {
        if (!connectedNames.has(key)) backendHealth.reportConnectFailed(key, connectFailures.get(key) || 'could not connect');
    }

    // 4. Clear and repopulate maps immediately (important for consistency)
    logger.log("Clearing and repopulating internal maps (tools, resources, prompts)...");
    const previousTools = new Map(toolToClientMap);
    toolToClientMap.clear();
    resourceToClientMap.clear();
    promptToClientMap.clear();

    // Repopulate Tools Map (through the tool pins: only approved definitions).
    // A backend that is down, or whose tools/list fails now, keeps its last-known
    // tools if its config is unchanged: calls get the "backend down" error and
    // client tool lists stay stable.
    const keepPrevious = (c: ConnectedClient) => {
        for (const [key, value] of previousTools) {
            if (value.client.name === c.name && stableConfigString(value.client.config) === stableConfigString(activeServersConfigLocal[c.name])) {
                toolToClientMap.set(key, value);
            }
        }
    };
    for (const connectedClient of currentConnectedClients) {
        if (!backendHealth.isUp(connectedClient.name) || !(await loadBackendTools(connectedClient))) keepPrevious(connectedClient);
    }
    toolPins?.endBaseline();
    toolMapVersion++;
    logger.log(`  Updated tool map with ${toolToClientMap.size} enabled tools.`);

    // Repopulate Resources Map
    for (const connectedClient of liveClients()) {
         try {
             const result = await connectedClient.client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema);
             if (result.resources) {
                 result.resources.forEach(resource => resourceToClientMap.set(resource.uri, connectedClient));
             }
         } catch (error: any) {
              if (!(error?.name === 'McpError' && error?.code === -32601)) { // Ignore 'Method not found'
                  logger.error(`Error fetching resources from ${connectedClient.name} during map update:`, error?.message || error);
              }
         }
    }
     logger.log(`  Updated resource map with ${resourceToClientMap.size} resources.`);

    // Repopulate Prompts Map
    for (const connectedClient of liveClients()) {
         try {
             const result = await connectedClient.client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema);
             if (result.prompts) {
                 result.prompts.forEach(prompt => promptToClientMap.set(prompt.name, connectedClient));
             }
         } catch (error: any) {
              if (!(error?.name === 'McpError' && error?.code === -32601)) { // Ignore 'Method not found'
                  logger.error(`Error fetching prompts from ${connectedClient.name} during map update:`, error?.message || error);
              }
         }
    }
    logger.log(`  Updated prompt map with ${promptToClientMap.size} prompts.`);

    // Lethal-trifecta classification follows the backend set (kinds are detected
    // from each backend's command line); log how the current tools classify.
    configureTrifecta(currentActiveServersConfig, currentSeparator);
    const classified = Array.from(toolToClientMap.values()).map(
        ({ client, toolInfo }) => ({ backend: client.name, tool: toolInfo.name }));
    const trifectaCfg = (await currentPolicy()).trifecta;
    logger.log(summarizeClassification(classified, trifectaCfg));
    const selfCompleting = selfCompletingTools(classified, trifectaCfg);
    if (selfCompleting.length) {
        logger.warn(`trifecta: ${selfCompleting.length} tool(s) are classified on all three axes and will be refused in every session ` +
            `unless an allow rule exempts the caller; reclassify them in the trifecta section of tool_policy.json: ${selfCompleting.join(', ')}`);
    }
    logger.log("Backend connections update finished.");
    announceToolListChanged();
}

/**
 * Reconnect one backend now (the SSE per-call reconnect, the mailbox editor).
 * On failure its last-known tools stay listed and the backend is retried with
 * backoff (backendHealth.ts); calls get the "backend down" error meanwhile.
 */
export async function refreshBackendConnection(serverKey: string, serverConfig: TransportConfig): Promise<boolean> {
  logger.log(`Attempting to refresh backend connection for server: ${serverKey}`);
  const configToUse = serverConfig || currentActiveServersConfig[serverKey] || currentConnectedClients.find(c => c.name === serverKey)?.config;
  if (!configToUse) {
    logger.error(`Configuration for server ${serverKey} not found. Cannot refresh.`);
    return false;
  }
  try {
    await connectBackend(serverKey, configToUse, false);
    markConnected(currentConnectedClients.find(c => c.name === serverKey)!);
    logger.log(`Repopulated maps for ${serverKey}.`);
    return true;
  } catch (error: any) {
    logger.error(`Failed to refresh backend connection for ${serverKey}: ${error.message}`);
    // A backend removed meanwhile is not retried.
    if (currentActiveServersConfig[serverKey]) backendHealth.reportConnectFailed(serverKey, error?.message || String(error));
    return false;
  }
}

// --- Tool pins: admin operations (sse.ts /admin/tool-pins*) ---

export function getToolPinState(): PinSnapshot | { enabled: false } {
    return toolPins ? toolPins.snapshot() : { enabled: false };
}

export function onToolPinsChanged(fn: () => void): void {
    toolPins?.onChange(fn);
}

/**
 * Re-list one backend (or all) through the pins. After an approval this is how
 * the tool comes back: from the backend's CURRENT definition, so a definition
 * that changed again since the admin looked is held again, never served.
 */
export async function recheckToolPins(backend?: string): Promise<void> {
    if (toolPins && !backend) toolPins.load(); // picks up a deleted/fixed pin file
    // A backend that is down is re-checked when it reconnects (connectBackend).
    const targets = liveClients().filter(c => backend === undefined || c.name === backend).map(c => c.name);
    for (const name of targets) {
        await withBackendLock(name, async () => {
            // The connection current once the lock is ours, not one a reconnect replaced.
            const c = liveClients().find(x => x.name === name);
            if (c) await loadBackendTools(c);
        });
    }
    toolPins?.endBaseline();
    toolMapVersion++;
    announceToolListChanged();
}

function requirePins(): ToolPinStore {
    if (!toolPins) throw Object.assign(new Error('Tool pinning is off (MCP_PIN_TOOLS=false).'), { status: 400 });
    return toolPins;
}

export async function approveToolPin(backend: string, tool: string, hash: string, admin: string): Promise<void> {
    logPinEvents([requirePins().approve(backend, tool, hash, admin)]);
    await recheckToolPins(backend);
}

export async function rejectToolPin(backend: string, tool: string, hash: string, admin: string): Promise<void> {
    logPinEvents([requirePins().reject(backend, tool, hash, admin)]);
}

export async function approveBackendToolPins(backend: string, hashes: Record<string, string>, admin: string): Promise<void> {
    logPinEvents(requirePins().approveBackend(backend, hashes, admin));
    await recheckToolPins(backend);
}

// --- Function to get current proxy state ---
export const getCurrentProxyState = () => {
    // Return copies or relevant info to avoid direct mutation
    const tools = Array.from(toolToClientMap.entries()).map(([qualifiedName, { client: connectedClient, toolInfo }]) => {
        // Return structure expected by the frontend (tools.js)
        return {
            // Frontend expects original tool name here
            name: toolInfo.name,
            // Frontend expects snake_case server name here
            serverName: connectedClient?.name || 'Unknown',
            // Frontend expects original description here
            description: toolInfo.description
            // qualifiedName is not directly used by the frontend display logic,
            // but could be added if needed: qualified_name: qualifiedName
        };
    });
    // Could add resources and prompts here if needed by admin UI later
    // Also return the current separator for the frontend
    return { tools, serverToolnameSeparator: currentSeparator };
};

// Helper function to identify connection errors
const isConnectionError = (err: any): boolean => {
  if (err && err.message) {
    const lowerMessage = err.message.toLowerCase();
    return lowerMessage.includes("disconnected") ||
           lowerMessage.includes("not connected") ||
           lowerMessage.includes("connection closed") ||
           lowerMessage.includes("transport is closed") || // SDK specific
           lowerMessage.includes("failed to fetch") || 
           lowerMessage.includes("not found") || //Error POSTING session not found
           lowerMessage.includes("404") || 
           lowerMessage.includes("eof") || // Network level
           lowerMessage.includes("tls") || // TLS handshake
           lowerMessage.includes("timeout") ||
           lowerMessage.includes("timed out"); 
  }
  return false;
};

/** A connection-level failure, not a slow backend: a timeout alone never marks a backend down. */
const isTransportFailure = (err: any): boolean => {
  if (!isConnectionError(err)) return false;
  const m = String(err?.message || '').toLowerCase();
  return !(m.includes('timeout') || m.includes('timed out')) && err?.code !== -32001;
};

const HTTP_PROBE_TIMEOUT_MS = 5000;

/**
 * A call to a streamable-HTTP backend failed at the transport level (its
 * server restarted and dropped our session, or it is gone): confirm with an
 * MCP ping; no answer marks it down, so it is reconnected, and returns the
 * "backend down" error.
 */
async function probeHttpAfterFailure(c: ConnectedClient, err: any): Promise<McpError | undefined> {
    if (c.transportType !== 'http' || !isTransportFailure(err)) return undefined;
    try {
        await c.client.ping({ timeout: HTTP_PROBE_TIMEOUT_MS });
        return undefined;
    } catch (probeError: any) {
        // Only the backend's current connection counts: a reload may have
        // removed or replaced it during the ping, and reportDown would then
        // recreate its health record and retry a backend that is gone.
        if (currentConnectedClients.find(x => x.name === c.name) !== c) return backendUnavailableError(c.name);
        backendHealth.reportDown(c.name, `no answer to ping after a failed call: ${probeError?.message || probeError}`);
        return backendUnavailableError(c.name);
    }
}

/** Why a retry of a tool call was not sent (audit `retryRefused`). */
type RetryRefusal = 'not-read' | 'held' | 'removed' | 'definition-changed' | 'denied' | 'backend-down' | 'trifecta';

/** `<backend><sep><tool>` for a configured backend that is down, if the name is one. */
const downBackendKey = (name: string): { backend: string; tool: string } | undefined => {
  const renamed = Object.entries(currentToolConfig.tools || {}).find(([, o]) => o?.exposedName === name);
  const key = renamed ? renamed[0] : name;
  let best: { backend: string; tool: string } | undefined;
  for (const backend of Object.keys(currentActiveServersConfig)) {
    const prefix = `${backend}${currentSeparator}`;
    if (key.startsWith(prefix) && key.length > prefix.length && !backendHealth.isUp(backend)
        && (!best || backend.length > best.backend.length)) {
      best = { backend, tool: key.slice(prefix.length) };
    }
  }
  return best;
};

// --- Server Creation ---
export const createServer = async () => {
  // Load initial config
  const initialServerConfig = await loadConfig(); // This now includes proxy settings
  const initialToolConfig = await loadToolConfig();

  // Initialize currentActiveServersConfig AND currentProxyConfig from the initial load
  const initialActiveServers: Record<string, TransportConfig> = {};
    for (const serverKey in initialServerConfig.mcpServers) {
        if (Object.prototype.hasOwnProperty.call(initialServerConfig.mcpServers, serverKey)) {
            const serverConf = initialServerConfig.mcpServers[serverKey];
            const isActive = !(serverConf.active === false || String(serverConf.active).toLowerCase() === 'false');
            if (isActive) {
                initialActiveServers[serverKey] = serverConf;
            }
        }
    }
  currentActiveServersConfig = initialActiveServers;
  // Update currentProxyConfig using initialServerConfig and global defaults
  currentProxyConfig = {
      ...defaultProxySettingsFull,
      ...(initialServerConfig.proxy || {}),
  };


  // Perform initial connection and map population
  await updateBackendConnections(initialServerConfig, initialToolConfig);

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)); // Define sleep

  // Cleanup function needs to handle the *current* list of clients
  const cleanup = async () => {
    logger.log(`Cleaning up ${currentConnectedClients.length} connected clients...`);
    backendHealth.stop();
    await Promise.all(currentConnectedClients.map(async (c) => {
        const name = c.name;
        try {
            await retire(c);
             logger.log(`  Cleaned up client: ${name}`);
        } catch(error: any) {
             logger.error(`  Error cleaning up client ${name}: ${error.message}`);
        }
    }));
    currentConnectedClients = []; // Clear the list after cleanup
  };

  // Backend connections are process-wide and shared; the *protocol* server is not.
  // Callers get a factory instead of a single instance -- see buildServerInstance.
  return { cleanup, createServerInstance: () => buildServerInstance(sleep) };
};

/**
 * Build a fresh Server (protocol) instance with every request handler registered.
 *
 * One of these per client session. They deliberately share the module-level
 * backend state (currentConnectedClients, toolToClientMap, ...) -- the backends
 * are a process-wide resource -- but each gets its own Protocol, and therefore
 * its own `_transport`.
 *
 * That last part is the whole point. Protocol.connect() assigns `this._transport`
 * and _onrequest() replies via `this._transport`, so a *shared* Server connected
 * to a second transport silently starts sending the first client's responses to
 * the second client. On @modelcontextprotocol/sdk 1.12.0 there is no guard against
 * this at all (later versions throw "Already connected to a transport" instead),
 * so the failure mode here was silent cross-session response delivery rather than
 * an error. Reproduced in repro-session-bleed.mjs before this change.
 */
function buildServerInstance(sleep: (ms: number) => Promise<unknown>) {
  // Create the per-session proxy server instance
  const server = new Server(
    {
      name: "patchbay-gateway",
      version: VERSION,
    },
    {
      capabilities: {
        prompts: {},
        resources: { subscribe: true },
        // Sent when a lazy backend is activated in this session (lazy.ts), and
        // when the approved tool set changes (toolPins.ts).
        tools: { listChanged: true },
      },
    },
  );

  liveServers.add(server);
  server.onclose = () => { liveServers.delete(server); };

  // Lazy backends (lazy.ts) this session has activated. Per session by
  // construction: one Server instance per client session, gone when it ends.
  const activatedLazy = new Set<string>();

  // --- Request Handlers ---
  // These handlers now rely on the maps populated by updateBackendConnections
  // Note: InitializeRequest is handled by the SDK's Server default behavior.

  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    logger.log("Received tools/list request - applying overrides from config");
    // Hide what the caller may not call. This is presentation only -- the
    // tools/call handler re-checks, because a client can call any name it likes.
    const identity = identityFor(extra);
    const policy = await currentPolicy();
    let hidden = 0;
    // Collect alongside the ORIGINAL qualified name -- that's the key the admin UI
    // layout is stored under, and what we sort by (the exposed name may be overridden).
    const collected: { key: string; tool: Tool }[] = [];
    // Access the globally stored tool config which includes overrides
    const toolOverrides = currentToolConfig.tools || {};
    // Tool collapsing (collapse.ts): members of a collapsed tool are listed once,
    // under the collapsed name, with `host` limited to the members this caller
    // may use. Each member is still decided individually by the policy below.
    const collapse = shouldCollapseTools(identity) ? currentCollapsePlan(policy.trifecta) : undefined;
    const allowedHosts = new Map<string, string[]>();
    // Lazy backends (lazy.ts) not activated in this session: their allowed tools
    // are only counted, and the backend is published as its activate tool.
    const lazy = currentLazyIndex();
    const lazyAllowed = new Map<string, number>();
    let lazyReachable = 0; // allowed tools on any lazy backend, activated or not

    for (const [originalQualifiedName, { client: connectedClient, toolInfo }] of toolToClientMap.entries()) {
        if (!mayUse(policy, identity, connectedClient.name, toolInfo.name)) {
            hidden++;
            continue;
        }
        if (lazy.backends.has(connectedClient.name)) lazyReachable++;
        if (lazy.backends.has(connectedClient.name) && !activatedLazy.has(connectedClient.name)) {
            lazyAllowed.set(connectedClient.name, (lazyAllowed.get(connectedClient.name) ?? 0) + 1);
            continue;
        }
        const collapsedName = collapse?.memberOf.get(originalQualifiedName);
        if (collapsedName) {
            const hosts = allowedHosts.get(collapsedName);
            if (hosts) hosts.push(connectedClient.name); else allowedHosts.set(collapsedName, [connectedClient.name]);
            continue;
        }
        const overrideSettings = toolOverrides[originalQualifiedName];

        // Determine the final name and description to expose
        // Use override if present, otherwise use original value
        const exposedName = overrideSettings?.exposedName || originalQualifiedName;
        const exposedDescription = overrideSettings?.exposedDescription || toolInfo.description;
        // A meta-tool name wins over a real tool of the same name (warned at
        // startup); listing both would publish one name twice.
        if (isMetaName(lazy, exposedName)) continue;

        // Construct the Tool object for the response
        collected.push({
            key: originalQualifiedName,
            tool: {
                name: exposedName, // Use the final exposed name
                description: exposedDescription, // Use the final exposed description
                inputSchema: toolInfo.inputSchema, // Schema is never overridden
                // Passed through as the backend declares them, so clients can show
                // a title, apply read-only/destructive hints to approval prompts and
                // validate structured results. Never overridden either.
                ...(toolInfo.title !== undefined ? { title: toolInfo.title } : {}),
                ...(toolInfo.annotations !== undefined ? { annotations: toolInfo.annotations } : {}),
                ...(toolInfo.outputSchema !== undefined ? { outputSchema: toolInfo.outputSchema } : {}),
            },
        });
    }

    for (const [name, hosts] of allowedHosts) {
        hosts.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        collected.push({ key: name, tool: renderCollapsedTool(collapse!.tools.get(name)!, hosts) });
    }

    // A caller with no allowed tool on a lazy backend never sees it at all, and
    // one who can reach no lazy tool doesn't get the gateway meta-tools either.
    for (const [backend, count] of lazyAllowed) {
        const tool = renderActivateTool(backend, lazy.backends.get(backend) ?? '', count, currentSeparator);
        collected.push({ key: tool.name, tool });
    }
    if (lazyReachable > 0) {
        const notLoaded = [...lazyAllowed.values()].reduce((a, n) => a + n, 0);
        for (const tool of renderGatewayTools(currentSeparator, lazyAllowed.size, notLoaded)) collected.push({ key: tool.name, tool });
    }

    // Deterministic ordering: admin-defined layout first, then anything else
    // alphabetically. Plain code-unit compare (not localeCompare) so the result
    // doesn't depend on the host's locale.
    const ranks = await loadToolOrderRanks();
    const UNRANKED = Number.MAX_SAFE_INTEGER;
    collected.sort((a, b) => {
        const ra = ranks.has(a.key) ? ranks.get(a.key)! : UNRANKED;
        const rb = ranks.has(b.key) ? ranks.get(b.key)! : UNRANKED;
        if (ra !== rb) return ra - rb;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    const enabledTools: Tool[] = collected.map(c => c.tool);
    logger.log(`Returning ${enabledTools.length} enabled tools with applied overrides (ordered: ${ranks.size} from layout, rest alphabetical)${collapse ? `; ${allowedHosts.size} collapsed` : ''}${lazyAllowed.size ? `; ${lazyAllowed.size} lazy backend(s) not activated` : ''}${policy.configured ? `; ${hidden} hidden by tool policy for ${identity.kind}:${identity.username}` : ''}.`);
    return { tools: enabledTools };
  });

  // Filled in as the call is resolved, so an audit line can still name the tool
  // key and backend for a call that resolved and then failed.
  // `tool`/`arguments`/`via`/`meta` are set by the lazy meta-tools: call_read /
  // call_write audit the real tool (via), the others are gateway meta-calls.
  interface ToolCallAuditCtx {
    toolKey?: string; backend?: string; authz?: AuthzDecision; trifecta?: TrifectaDecision['detail'];
    tool?: string; arguments?: unknown; via?: string; meta?: string;
    /** tools/call requests actually sent to the backend. */
    attempts?: number;
    /** Set when a failed call was not retried, or a retry was refused before it was sent. */
    retryRefused?: RetryRefusal;
  }

  /**
   * `resolvedKey`: the qualified key is already known (a lazy `call`), so skip
   * name resolution and collapsing. Everything from authorization on is the same.
   * `extra`: the client request's handler context, to relay backend progress.
   * `requireRead`: call_read -- the tool must still be classed read when sent.
   */
  const forwardToolCall = async (request: any, audit: ToolCallAuditCtx, identity: CallerIdentity, sessionId: string | undefined,
                                 extra: any, resolvedKey?: string, requireRead = false): Promise<any> => {
    let { name: requestedExposedName, arguments: args } = request.params;
    let originalQualifiedName: string | undefined;
    let mapEntry: { client: ConnectedClient, toolInfo: Tool } | undefined;

    // Need to find the original tool based on the potentially overridden exposed name
    const toolOverrides = currentToolConfig.tools || {};

    if (resolvedKey !== undefined) {
        const entry = toolToClientMap.get(resolvedKey);
        if (entry) {
            originalQualifiedName = resolvedKey;
            mapEntry = entry;
        }
        requestedExposedName = toolOverrides[resolvedKey]?.exposedName || resolvedKey;
    } else {

        // A collapsed name (collapse.ts) is rewritten to the real per-host tool and
        // `host` is dropped from the arguments, before anything else reads either.
        // From here on the call is exactly a call to `<host><sep><tool>`: same
        // authorization, trifecta, audit key and backend, retries and shaping.
        if (shouldCollapseTools(identity)) {
            const collapsePolicy = await currentPolicy();
            const routed = resolveCollapsedCall(currentCollapsePlan(collapsePolicy.trifecta), requestedExposedName, args);
            if (routed.kind === 'bad-host') {
                if (typeof routed.host === 'string') {
                    const held = await pendingReviewError(routed.host, routed.tool.toolName, identity);
                    if (held) throw held;
                }
                // Name only the hosts this caller may use, as tools/list does.
                const hosts = [...routed.tool.members.keys()].filter(backend => mayUse(collapsePolicy, identity, backend, routed.tool.toolName));
                throw gatewayError(-32602, `Tool "${requestedExposedName}" needs "${HOST_PARAM}" set to one of: ${hosts.join(', ') || '(none available)'}.`);
            }
            if (routed.kind === 'route') {
                logger.log(`Collapsed tool '${requestedExposedName}' with ${HOST_PARAM}='${routed.backend}' -> '${routed.key}'`);
                requestedExposedName = routed.key;
                args = routed.args;
            }
        }

        // Iterate through the live tool map to find which original tool corresponds
        // to the requested exposed name.
        for (const [key, { client, toolInfo: currentToolInfo }] of toolToClientMap.entries()) { // Renamed toolInfo to currentToolInfo to avoid conflict
            const overrideSettings = toolOverrides[key];
            const currentExposedName = overrideSettings?.exposedName || key; // Calculate the exposed name for this tool

            if (currentExposedName === requestedExposedName) {
                originalQualifiedName = key; // Found the original key
                mapEntry = { client, toolInfo: currentToolInfo }; // Get the corresponding entry
                break;
            }
        }
    }

    // If no entry was found after checking all enabled tools and their potential overrides
    if (!mapEntry || !originalQualifiedName) {
        const heldKey = heldByKey(resolvedKey ?? requestedExposedName);
        if (heldKey) {
            const held = await pendingReviewError(heldKey.backend, heldKey.tool, identity);
            if (held) throw held;
        }
        // A backend that is down and has never listed its tools (it failed to
        // connect at startup): say so, to a caller who may use that tool.
        const downKey = downBackendKey(resolvedKey ?? requestedExposedName);
        if (downKey && mayUse(await currentPolicy(), identity, downKey.backend, downKey.tool)) {
            audit.backend = downKey.backend;
            throw backendUnavailableError(downKey.backend)!;
        }
        const errorMessage = `Attempted to call tool with exposed name "${requestedExposedName}", but no corresponding enabled tool or override configuration found.`;
        logger.error(errorMessage);
        throw gatewayError(-32601, errorMessage); // Method not found error code
    }

    // Now we have the correct mapEntry and the originalQualifiedName
    let { client: clientForTool, toolInfo } = mapEntry; // toolInfo here is the correct one from the found mapEntry
    const originalToolNameForBackend = toolInfo.name; // The actual name the backend server expects (from the original toolInfo)
    const backendName = clientForTool.name;
    // The definition this call was approved against. Every dispatch, retries
    // included, must still find exactly this definition (checkBeforeDispatch).
    const approvedHash = hashDefinition(toolInfo);

    audit.toolKey = originalQualifiedName;
    audit.backend = clientForTool.name;

    // Authorization. Enforced here, not only in tools/list: hiding a tool is not
    // a boundary, since a client can call any name it knows. Decided on the
    // ORIGINAL backend and tool names, so exposed-name overrides cannot be used
    // to step around a rule.
    const policy = await currentPolicy();
    const decision = policy.decide({ identity, backend: clientForTool.name, tool: originalToolNameForBackend, sessionId });
    audit.authz = decision;
    if (!decision.allowed) {
        logger.warn(`Denied tools/call '${requestedExposedName}' (${originalQualifiedName}) for ${identity.kind}:${identity.username} -- ${decision.rule}: ${decision.reason}`);
        throw gatewayError(AUTHZ_DENIED_CODE, `Tool "${requestedExposedName}" is not permitted for this caller.`);
    }

    // Backend down or failed (backendHealth.ts): a clear error, not a retry
    // storm against a dead connection. After authz, so a caller who may not use
    // the tool still gets the denial; before trifecta, so a call that never
    // reaches a backend does not count against the session.
    const unavailable = backendUnavailableError(clientForTool.name);
    if (unavailable) throw unavailable;

    // Lethal trifecta (trifecta.ts): authorization says this caller may use the
    // tool; this says whether this *session* may use it now, given what it has
    // already touched. After authz, so a call the caller may not make at all is
    // never counted against the session. Before forwarding, so a refused call
    // never reaches the backend. Synchronous from here to the check-and-record.
    const trifecta = checkTrifecta(sessionId, identity, clientForTool.name, originalToolNameForBackend, policy.trifecta);
    audit.trifecta = trifecta.detail;
    if (!trifecta.allowed) {
        throw gatewayError(TRIFECTA_BLOCKED_CODE, trifecta.message || 'Blocked by lethal-trifecta policy', { trifecta: trifecta.detail });
    }

    // --- Retry Logic ---
    // Use HTTP retry settings for SSE as a fallback for retry count and delay
    const maxRetries = clientForTool.transportType === 'sse' ? (currentProxyConfig.retrySseToolCall ? currentProxyConfig.sseToolCallMaxRetries : 0) : // Use SSE specific max retries, check retrySseToolCall
                       clientForTool.transportType === 'stdio' ? (currentProxyConfig.retryStdioToolCall ? currentProxyConfig.stdioToolCallMaxRetries : 0) :
                       clientForTool.transportType === 'http' ? (currentProxyConfig.retryHttpToolCall ? currentProxyConfig.httpToolCallMaxRetries : 0) : 0;
    const retryDelayBaseMs = clientForTool.transportType === 'sse' ? currentProxyConfig.sseToolCallRetryDelayBaseMs : // Use SSE specific retry delay
                             clientForTool.transportType === 'stdio' ? (currentProxyConfig.retryStdioToolCall ? currentProxyConfig.stdioToolCallRetryDelayBaseMs : 0) : // Added check for stdio retry enabled
                             clientForTool.transportType === 'http' ? (currentProxyConfig.retryHttpToolCall ? currentProxyConfig.httpToolCallRetryDelayBaseMs : 0) : 0; // Added check for http retry enabled

    let lastError: any = null;
    let attempts = 0;

    // Loop includes the initial attempt (attempt 0) plus maxRetries. Only a
    // tool classed read is retried (see the catch below): a timeout or a lost
    // connection does not prove a write did not run, and replaying it could
    // repeat its side effects.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const delay = retryDelayBaseMs * Math.pow(2, attempt - 1) + (Math.random() * retryDelayBaseMs * 0.5);
            logger.log(`Tool call failed for '${requestedExposedName}'. Attempt ${attempt}/${maxRetries}. Retrying in ${delay.toFixed(0)}ms...`);
            await sleep(delay);
        }
        // For SSE, reconnect before the first attempt, or before a retry after a connection error.
        if (clientForTool.transportType === 'sse' && (attempt === 0 || isConnectionError(lastError))) {
            logger.log(`SSE connection handling for tool '${requestedExposedName}' on server '${backendName}'. Attempting reconnect.`);
            const clientTransportConfig = currentActiveServersConfig[backendName];
            if (!clientTransportConfig) {
                logger.error(`Cannot proceed with SSE: TransportConfig for server '${backendName}' not found.`);
                throw gatewayError(-32000, `SSE TransportConfig for server '${backendName}' not found for tool '${requestedExposedName}'.`);
            }
            if (!(await refreshBackendConnection(backendName, clientTransportConfig))) {
                logger.error(`SSE Reconnection to server '${backendName}' failed.`);
                throw backendUnavailableError(backendName)
                    ?? gatewayError(-32000, `SSE Reconnection to server '${backendName}' failed for tool '${requestedExposedName}'.`);
            }
            logger.log(`Successfully reconnected to server '${backendName}' via SSE.`);
        }

        // Checked again right before EVERY dispatch, retries included: the
        // tool may have been held, removed or changed, the caller de-authorized
        // or the backend taken down while this call waited. The connection is
        // the tool's current one, never the one captured above.
        const policyNow = await currentPolicy();
        const check = checkBeforeDispatch(policyNow, {
            key: originalQualifiedName, backend: backendName, tool: originalToolNameForBackend, approvedHash,
            exposedName: requestedExposedName, identity, sessionId, attempt, requireRead, lastError, audit,
        });
        if ('refused' in check) {
            if (attempt > 0) audit.retryRefused = check.refused;
            logger.warn(`tools/call '${requestedExposedName}' (${originalQualifiedName}): attempt ${attempt + 1} not sent (${check.refused}).`);
            throw check.error;
        }
        clientForTool = check.entry.client;
        toolInfo = check.entry.toolInfo;
        audit.backend = clientForTool.name;
        // Synchronous from the check above to the request below.

        try {
            logger.log(`Forwarding tool call for exposed name '${requestedExposedName}' (original qualified name: '${originalQualifiedName}'). Forwarding to server '${clientForTool.name}' as tool '${originalToolNameForBackend}' (Attempt ${attempt + 1})`);
            // The client's _meta goes to the backend whole, except progressToken:
            // the backend gets a gateway token instead, and its progress is
            // relayed to the client under the client's token, on the client's
            // request stream (see "Progress relay" above).
            const { progressToken: clientProgressToken, ...clientMeta } = (request.params._meta ?? {}) as Record<string, unknown>;
            const gatewayToken = clientProgressToken !== undefined && extra?.sendNotification ? `patchbay-progress-${randomUUID()}` : undefined;
            if (gatewayToken) {
                routeBackendProgress(clientForTool.client);
                progressRoutes.set(gatewayToken, (p) => {
                    extra.sendNotification({ method: 'notifications/progress', params: { ...p, progressToken: clientProgressToken } })
                        .catch((e: any) => logger.warn(`Could not relay progress for '${requestedExposedName}': ${e?.message || e}`));
                });
            }
            const upstreamMeta = { ...clientMeta, ...(gatewayToken ? { progressToken: gatewayToken } : {}) };
            let backendResponse;
            try {
                audit.attempts = ++attempts;
                backendResponse = await clientForTool.client.request(
                    {
                        method: 'tools/call',
                        params: { name: originalToolNameForBackend, arguments: args || {}, ...(Object.keys(upstreamMeta).length ? { _meta: upstreamMeta } : {}) }
                    },
                    CompatibilityCallToolResultSchema,
                    { timeout: DEFAULT_REQUEST_TIMEOUT_MSEC } // Set timeout explicitly
                );
            } finally {
                if (gatewayToken) setImmediate(() => progressRoutes.delete(gatewayToken));
            }
            logger.log(`[Tool Call] Backend response received for '${requestedExposedName}'. Passing to SDK Server.`);
            return backendResponse; // Success! Return the response.
        } catch (error: any) {
            lastError = error;
            logger.warn(`Attempt ${attempt + 1} to call tool '${requestedExposedName}' failed: ${error.message}`);

            // The backend went down under this call (its transport closed):
            // retrying a dead connection only delays the clear error.
            const died = backendUnavailableError(clientForTool.name);
            if (died) throw died;

            // Check if this error warrants a retry based on type and configuration
            const isRetryableError = isConnectionError(error) || (error?.name === 'McpError' && error?.code === -32001); // Consider timeout as retryable
            const shouldRetry = (clientForTool.transportType === 'sse' && currentProxyConfig.retrySseToolCall && isRetryableError) || // Check retrySseToolCall
                                (clientForTool.transportType === 'stdio' && currentProxyConfig.retryStdioToolCall && isRetryableError) ||
                                (clientForTool.transportType === 'http' && currentProxyConfig.retryHttpToolCall && isRetryableError);

            if (!shouldRetry) {
                 logger.error(`Tool call for '${requestedExposedName}' failed with non-retryable error${attempt > 0 ? ' after retries' : ' on first attempt'}: ${error.message}`, error);
                 // If the error is already an McpError, re-throw it directly. Otherwise, wrap it.
                 if (error instanceof McpError) {
                     throw bareError(error);
                 } else {
                     throw gatewayError(error?.code || -32000, error.message || 'An unknown error occurred', error?.data);
                 }
            }

            // Retryable, but only a tool classed read is replayed (the class
            // call_read uses: toolClass, then readOnlyHint, else write). The
            // transport is still recovered: a closed stdio transport was
            // reported down above, an HTTP backend is probed here, and an SSE
            // backend is refreshed before its next call.
            if ((await currentPolicy()).classifyTool(clientForTool.name, toolInfo.name, toolInfo.annotations as any).toolClass !== 'read') {
                audit.retryRefused = 'not-read';
                const down = await probeHttpAfterFailure(clientForTool, error);
                if (down) throw down;
                logger.warn(`Tool call for '${requestedExposedName}' failed (${error.message}) and is not retried: the tool is not classed read.`);
                throw notRetriedError(requestedExposedName, error);
            }

            // If it's a retryable error and we are within maxRetries, the loop continues.
            // If it's a retryable error but we are at maxRetries, the loop will exit after this iteration.
        }
    }

    // All retries failed at the transport level on a streamable-HTTP backend:
    // the ping probe marks it down, so it is reconnected.
    const down = await probeHttpAfterFailure(clientForTool, lastError);
    if (down) throw down;

    // If the loop finishes without returning, it means all retries failed.
    const errorMessage = `Error calling tool '${requestedExposedName}' after ${maxRetries} retries (on backend server '${clientForTool.name}', original tool name '${originalToolNameForBackend}'): ${stripMcpPrefix(lastError?.message || 'An unknown error occurred')}`;
    logger.error(errorMessage, lastError);
    // Ensure a structured McpError is returned to the client
    throw gatewayError(lastError?.code || -32000, errorMessage, lastError?.data);
  };

  /** The error for a failed call that is not replayed because the tool is not classed read. */
  const notRetriedError = (exposedName: string, error: any): McpError => {
    const data = error?.data && typeof error.data === 'object' && !Array.isArray(error.data) ? error.data : {};
    return gatewayError(error?.code || -32000,
      `Tool call '${exposedName}' failed and was not retried: the tool is not classed read, and a timeout or lost connection ` +
      `does not prove it did not run. ${stripMcpPrefix(error?.message || 'An unknown error occurred')}`,
      { ...data, notRetried: { reason: 'not-read' } });
  };

  /**
   * The check before every dispatch of a tools/call to a backend (attempt 0
   * and each retry), on the direct, collapsed and lazy paths alike. Nothing
   * decided before the call waited is carried over: the tool is looked up
   * again, must still have the definition it was approved with, and the
   * caller, the backend's state, the read class (call_read, and any retry)
   * and, on a retry, the lethal trifecta are decided again. Synchronous, so
   * the caller can send the request with nothing in between.
   */
  const checkBeforeDispatch = (policy: CompiledPolicy, c: {
    key: string; backend: string; tool: string; approvedHash: string; exposedName: string;
    identity: CallerIdentity; sessionId: string | undefined; attempt: number; requireRead: boolean; lastError: any; audit: ToolCallAuditCtx;
  }): { entry: { client: ConnectedClient; toolInfo: Tool } } | { refused: RetryRefusal; error: McpError } => {
    const entry = toolToClientMap.get(c.key);
    const held = () => pendingReviewErrorFor(policy, c.backend, c.tool, c.identity);
    if (!entry || entry.client.name !== c.backend || entry.toolInfo.name !== c.tool) {
      const h = held();
      if (h) return { refused: 'held', error: h };
      const down = backendUnavailableError(c.backend);
      if (down) return { refused: 'backend-down', error: down };
      return { refused: 'removed', error: notFound(c.exposedName) };
    }
    if (hashDefinition(entry.toolInfo) !== c.approvedHash) {
      const h = held();
      if (h) return { refused: 'held', error: h };
      return { refused: 'definition-changed', error: gatewayError(TOOL_PENDING_REVIEW_CODE,
        `Tool "${c.backend}/${c.tool}" changed its definition while this call was in progress, so the call was not sent again. List the tools and call it again.`,
        { pendingReview: { backend: c.backend, tool: c.tool, reason: 'definition-changed' } }) };
    }
    const decision = policy.decide({ identity: c.identity, backend: c.backend, tool: c.tool, sessionId: c.sessionId });
    c.audit.authz = decision;
    if (!decision.allowed) {
      logger.warn(`Denied tools/call '${c.exposedName}' (${c.key}) for ${c.identity.kind}:${c.identity.username} -- ${decision.rule}: ${decision.reason}`);
      return { refused: 'denied', error: gatewayError(AUTHZ_DENIED_CODE, `Tool "${c.exposedName}" is not permitted for this caller.`) };
    }
    const down = backendUnavailableError(c.backend);
    if (down) return { refused: 'backend-down', error: down };
    if (c.requireRead || c.attempt > 0) {
      if (policy.classifyTool(c.backend, c.tool, entry.toolInfo.annotations as any).toolClass !== 'read') {
        const via = gatewayToolName('call_read', currentSeparator);
        return { refused: 'not-read', error: c.attempt > 0
          ? notRetriedError(c.exposedName, c.lastError)
          : gatewayError(-32602, `${c.backend}/${c.tool} is a write tool; ${via} only runs read tools. Use ${gatewayToolName('call_write', currentSeparator)} for it.`) };
      }
    }
    if (c.attempt > 0) {
      const trifecta = checkTrifecta(c.sessionId, c.identity, c.backend, c.tool, policy.trifecta);
      if (trifecta.detail) c.audit.trifecta = trifecta.detail;
      if (!trifecta.allowed) {
        return { refused: 'trifecta', error: gatewayError(TRIFECTA_BLOCKED_CODE, trifecta.message || 'Blocked by lethal-trifecta policy', { trifecta: trifecta.detail }) };
      }
    }
    return { entry };
  };

  // Every tools/call is recorded, success or failure. recordToolCall is
  // fire-and-forget and swallows its own errors, so auditing cannot fail a call
  // -- but it is called on both paths before the result or error leaves here.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const audit: ToolCallAuditCtx = {};
    const identity = identityFor(extra);
    const sessionId = (extra as any)?.sessionId as string | undefined;
    const startedAt = Date.now();
    const toolName = request.params.name;

    // Per-identity throttle (ratelimit.ts), before authorization and before
    // anything reaches a backend. Recorded as an `event: 'rate-limit'` audit
    // line (coalesced) rather than a tools/call line, so a throttled loop
    // cannot flood the audit log.
    if (RATE_LIMIT_ENABLED) {
      const key = rateKey(identity, sessionId);
      const decision = toolCallLimiter.take(key);
      if (!decision.allowed) {
        const data = rateLimitErrorData('tools/call', decision, TOOL_CALL_LIMIT);
        recordRateLimit({
          identity, sessionId, scope: 'tools/call', key, tool: toolName,
          errorCode: RATE_LIMITED_CODE, retryAfterMs: decision.retryAfterMs,
          burst: data.burst, perMinute: data.perMinute,
        });
        throw gatewayError(RATE_LIMITED_CODE, rateLimitMessage(identity, data), data);
      }
    }

    // The audit line describes the real tool where there is one: call_read /
    // call_write set audit.tool/arguments to the tool they routed to (and via).
    const lazyAuditFields = () => ({
      ...(audit.via ? { via: audit.via } : {}),
      ...(audit.meta ? { meta: audit.meta } : {}),
      ...(audit.attempts !== undefined ? { attempts: audit.attempts } : {}),
      ...(audit.retryRefused ? { retryRefused: audit.retryRefused } : {}),
    });

    try {
      const lazy = currentLazyIndex();
      const activateBackend = lazy.activate.get(toolName);
      const gatewayAction = lazy.gateway.get(toolName);
      const result = activateBackend !== undefined
        ? await handleActivate(activateBackend, audit, identity, sessionId, extra)
        : gatewayAction !== undefined
          ? await handleGatewayTool(gatewayAction, request, audit, identity, sessionId, extra)
          : await forwardToolCall(request, audit, identity, sessionId, extra);
      // A backend can report failure in-band via isError rather than throwing.
      const inBandError = result?.isError === true;
      recordToolCall({
        identity, sessionId, tool: audit.tool ?? toolName, toolKey: audit.toolKey, backend: audit.backend,
        ok: !inBandError,
        durationMs: Date.now() - startedAt,
        authz: audit.authz,
        ...(audit.trifecta ? { trifecta: audit.trifecta } : {}),
        ...(inBandError ? { errorMessage: 'backend returned isError' } : {}),
        ...lazyAuditFields(),
        arguments: audit.arguments !== undefined ? audit.arguments : request.params.arguments,
      });
      // Last, so the audit record above describes what the backend returned.
      return shapeToolResult(result, identity);
    } catch (err: any) {
      recordToolCall({
        identity, sessionId, tool: audit.tool ?? toolName, toolKey: audit.toolKey, backend: audit.backend,
        ok: false,
        durationMs: Date.now() - startedAt,
        authz: audit.authz,
        ...(audit.trifecta ? { trifecta: audit.trifecta } : {}),
        ...lazyAuditFields(),
        errorCode: err?.code,
        errorMessage: err?.message,
        arguments: audit.arguments !== undefined ? audit.arguments : request.params.arguments,
      });
      throw err;
    }
  });

  /** One backend tool this caller may use. */
  interface VisibleTool { key: string; backend: string; toolName: string; tool: Tool; lazy: boolean }

  /**
   * Every backend tool this caller may use (mayUse), optionally one backend's
   * only, with exposed-description overrides applied as in tools/list.
   */
  const visibleTools = (policy: CompiledPolicy, identity: CallerIdentity, onlyBackend?: string): VisibleTool[] => {
    const overrides = currentToolConfig.tools || {};
    const lazy = currentLazyIndex();
    const out: VisibleTool[] = [];
    for (const [key, { client, toolInfo }] of toolToClientMap.entries()) {
      if (onlyBackend !== undefined && client.name !== onlyBackend) continue;
      if (!mayUse(policy, identity, client.name, toolInfo.name)) continue;
      const description = overrides[key]?.exposedDescription || toolInfo.description;
      out.push({ key, backend: client.name, toolName: toolInfo.name, tool: { ...toolInfo, description }, lazy: lazy.backends.has(client.name) });
    }
    return out;
  };

  const notFound = (name: string) => {
    const errorMessage = `Attempted to call tool with exposed name "${name}", but no corresponding enabled tool or override configuration found.`;
    logger.error(errorMessage);
    return gatewayError(-32601, errorMessage);
  };

  /**
   * A call to a tool withheld by the tool pins (toolPins.ts) gets a clear
   * "pending review" error -- but only for a caller who may use that tool;
   * anyone else gets the same not-found as for a tool that doesn't exist.
   */
  const pendingReviewError = async (backend: string, toolName: string, identity: CallerIdentity): Promise<McpError | undefined> =>
    pendingReviewErrorFor(await currentPolicy(), backend, toolName, identity);

  /** pendingReviewError against a policy already in hand. */
  const pendingReviewErrorFor = (policy: CompiledPolicy, backend: string, toolName: string, identity: CallerIdentity): McpError | undefined => {
    const p = toolPins?.pendingFor(backend, toolName);
    if (!p) return undefined;
    if (!mayUse(policy, identity, backend, toolName)) return undefined;
    const why = p.reason === 'changed' ? 'its definition changed' : p.reason === 'pin-file-unreadable' ? 'the gateway cannot read its tool pins' : 'it is new';
    return gatewayError(TOOL_PENDING_REVIEW_CODE,
      `Tool "${backend}/${toolName}" is withheld: ${why} and it is pending admin review (rug-pull protection). Ask the gateway admin to review it.`,
      { pendingReview: { backend, tool: toolName, reason: p.reason } });
  };

  /** Qualified key (or a tool_config.json exposedName) -> held backend/tool. */
  const heldByKey = (name: string): { backend: string; tool: string } | undefined => {
    if (!toolPins) return undefined;
    const renamed = Object.entries(currentToolConfig.tools || {}).find(([, o]) => o?.exposedName === name);
    const key = renamed ? renamed[0] : name;
    for (const c of currentConnectedClients) {
      const prefix = `${c.name}${currentSeparator}`;
      if (key.startsWith(prefix) && toolPins.pendingFor(c.name, key.slice(prefix.length))) {
        return { backend: c.name, tool: key.slice(prefix.length) };
      }
    }
    return undefined;
  };

  /** For a `backend/tool` ref or qualified key that resolves to nothing: the pending-review error, if it is held. */
  const heldRefError = async (ref: unknown, identity: CallerIdentity): Promise<McpError | undefined> => {
    if (typeof ref !== 'string' || !ref) return undefined;
    const slash = ref.indexOf('/');
    if (slash > 0) return pendingReviewError(ref.slice(0, slash), ref.slice(slash + 1), identity);
    const k = heldByKey(ref);
    return k ? pendingReviewError(k.backend, k.tool, identity) : undefined;
  };

  /** `backend/tool` (as search returns it) or a qualified key -> the tool, if it exists. */
  const resolveRef = (ref: unknown): { key: string; backend: string; toolName: string } | undefined => {
    if (typeof ref !== 'string' || !ref) return undefined;
    const slash = ref.indexOf('/');
    if (slash > 0) {
      const backend = ref.slice(0, slash), toolName = ref.slice(slash + 1);
      const key = `${backend}${currentSeparator}${toolName}`;
      const entry = toolToClientMap.get(key);
      // Backend names may contain the separator: a ref never lands on another backend.
      return entry && entry.client.name === backend && entry.toolInfo.name === toolName ? { key, backend, toolName } : undefined;
    }
    const entry = toolToClientMap.get(ref);
    return entry ? { key: ref, backend: entry.client.name, toolName: entry.toolInfo.name } : undefined;
  };

  /** How this caller uses a tool from here: by name, or through call_read/call_write. */
  const howToUse = (v: VisibleTool, toolClass: 'read' | 'write'): string => {
    const exposed = currentToolConfig.tools?.[v.key]?.exposedName || v.key;
    if (v.lazy && !activatedLazy.has(v.backend)) {
      const via = gatewayToolName(toolClass === 'read' ? 'call_read' : 'call_write', currentSeparator);
      return `${via} {"tool": "${v.backend}/${v.toolName}"} — or ${v.backend}${currentSeparator}activate, then call ${exposed}`;
    }
    return `call ${exposed} directly`;
  };

  /** Lazy backend activation (lazy.ts): per session, plus tools/list_changed. */
  const handleActivate = async (backend: string, audit: ToolCallAuditCtx, identity: CallerIdentity,
                                sessionId: string | undefined, extra: any): Promise<any> => {
    audit.backend = backend;
    audit.meta = 'activate';
    const policy = await currentPolicy();
    const allowed = visibleTools(policy, identity, backend);
    // With nothing allowed the meta-tool answers exactly like a tool that doesn't exist.
    if (allowed.length === 0) throw notFound(`${backend}${currentSeparator}activate`);
    activatedLazy.add(backend);
    const overrides = currentToolConfig.tools || {};
    const lazy = currentLazyIndex();
    const published = allowed.map(v => overrides[v.key]?.exposedName || v.key).filter(n => !isMetaName(lazy, n)).sort();
    logger.log(`Lazy backend '${backend}' activated for session ${sessionId ?? '?'} (${identity.kind}:${identity.username}): ${published.length} tool(s).`);
    // On the activate request's own response stream (relatedRequestId), so it
    // reaches a streamable-HTTP client that never opened the optional GET stream.
    try {
      await extra.sendNotification({ method: 'notifications/tools/list_changed' });
    } catch (e: any) {
      logger.warn(`Could not send tools/list_changed for '${backend}': ${e?.message || e}`);
    }
    return { content: [{ type: 'text', text: activateText(backend, published, currentSeparator) }] };
  };

  /**
   * The gateway meta-tools (lazy.ts). search_tools and describe_tool only ever
   * reveal tools the caller may use. call_read / call_write are a direct call
   * to the real tool in every respect that matters: forwardToolCall does
   * authorization, trifecta and the backend call; the handler above does rate
   * limiting, audit and result shaping.
   */
  const handleGatewayTool = async (action: GatewayAction, request: any, audit: ToolCallAuditCtx,
                                   identity: CallerIdentity, sessionId: string | undefined, extra: any): Promise<any> => {
    const metaName: string = request.params.name;
    const args = request.params.arguments ?? {};
    const policy = await currentPolicy();
    const visible = visibleTools(policy, identity);
    // Listed only for callers who can reach a lazy tool; answer the rest like an unknown tool.
    if (!visible.some(v => v.lazy)) throw notFound(metaName);
    const classOf = (key: string) => {
      const entry = toolToClientMap.get(key)!;
      return policy.classifyTool(entry.client.name, entry.toolInfo.name, entry.toolInfo.annotations as any).toolClass;
    };

    if (action === 'call_read' || action === 'call_write') {
      audit.via = action;
      const inner = args.arguments;
      if (inner !== undefined && (inner === null || typeof inner !== 'object' || Array.isArray(inner))) {
        throw gatewayError(-32602, `${metaName}: "arguments" must be an object.`);
      }
      if (typeof args.tool !== 'string' || !args.tool) {
        throw gatewayError(-32602, `${metaName} needs "tool": "<backend>/<tool>", as ${gatewayToolName('search_tools', currentSeparator)} returns it.`);
      }
      const ref = resolveRef(args.tool);
      // Unknown: exactly the error a direct call to that name gets.
      const key = ref?.key ?? (args.tool.includes('/') ? args.tool.replace('/', currentSeparator) : args.tool);
      audit.tool = key;
      audit.arguments = inner ?? {};
      if (!ref) throw (await heldRefError(args.tool, identity)) ?? notFound(key);
      // call_read refuses a write tool -- but only once the caller may use it at
      // all, so a denied tool gets the direct call's denial, not its class.
      if (action === 'call_read' && mayUse(policy, identity, ref.backend, ref.toolName) && classOf(ref.key) === 'write') {
        audit.backend = ref.backend;
        audit.toolKey = ref.key;
        throw gatewayError(-32602, `${ref.backend}/${ref.toolName} is a write tool; ${metaName} only runs read tools. ` +
          `Use ${gatewayToolName('call_write', currentSeparator)} for it.`);
      }
      logger.log(`Gateway ${action} '${args.tool}' -> '${ref.key}'`);
      return forwardToolCall({ ...request, params: { ...request.params, name: ref.key, arguments: inner ?? {} } }, audit, identity, sessionId, extra, ref.key,
        action === 'call_read');
    }

    audit.meta = action;

    if (action === 'describe_tool') {
      const ref = resolveRef(args.tool);
      const v = ref && visible.find(x => x.key === ref.key);
      // Denied and nonexistent read the same, so describe can't probe the policy.
      if (!v && !ref) {
        const held = await heldRefError(args.tool, identity);
        if (held) throw held;
      }
      if (!v) throw gatewayError(-32602, `No tool "${String(args.tool ?? '')}" is available to you. ${gatewayToolName('search_tools', currentSeparator)} finds them.`);
      audit.backend = v.backend;
      const cls = classOf(v.key);
      return { content: [{ type: 'text', text: describeText(`${v.backend}/${v.toolName}`, v.tool, cls, howToUse(v, cls)) }] };
    }

    // search_tools
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const onlyBackend = typeof args.backend === 'string' && args.backend ? args.backend : undefined;
    const k = Math.min(SEARCH_MAX_K, Math.max(1, Number.isInteger(args.limit) ? args.limit : SEARCH_DEFAULT_K));
    const pool = onlyBackend ? visible.filter(v => v.backend === onlyBackend) : visible;
    const hit = (v: VisibleTool, score: number): SearchHit => {
      const cls = classOf(v.key);
      return { tool: `${v.backend}/${v.toolName}`, summary: `${v.backend}: ${firstSentence(v.tool.description)}`, class: cls, score, use: howToUse(v, cls) };
    };
    if (!query) {
      if (!onlyBackend) throw gatewayError(-32602, `${metaName} needs "query", or "backend" to list one backend's tools.`);
      // Listing one backend: every tool, name order, capped like a search with ties.
      const sorted = [...pool].sort((a, b) => (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0));
      const shown = sorted.slice(0, SEARCH_TIE_CEILING * 2);
      return { content: [{ type: 'text', text: searchText(`(all tools on ${onlyBackend})`, shown.map(v => hit(v, 0)), shown.length < sorted.length ? shown.length : undefined) }] };
    }
    // A collapsed tool (collapse.ts) is one hit, not one per host: rank one
    // document per collapsed name, carrying the host names this caller may use.
    const collapse = shouldCollapseTools(identity) ? currentCollapsePlan(policy.trifecta) : undefined;
    const units = new Map<string, { v: VisibleTool; hosts: string[] }>();
    for (const v of pool) {
      const collapsedName = collapse?.memberOf.get(v.key);
      const id = collapsedName ?? v.key;
      const unit = units.get(id);
      if (unit) unit.hosts.push(v.backend); else units.set(id, { v, hosts: collapsedName ? [v.backend] : [] });
    }
    const ranked = rankBM25(query, [...units.entries()].map(([id, u]) => ({
      item: { id, ...u },
      tokens: u.hosts.length > 1 ? [...searchTokensFor(u.v.key, u.v.backend, u.v.tool), ...u.hosts] : searchTokensFor(u.v.key, u.v.backend, u.v.tool),
    })), k, SEARCH_TIE_CEILING);
    const hits = ranked.map(({ item, score }) => {
      const h = hit(item.v, score);
      if (item.hosts.length > 1) {
        const hosts = [...item.hosts].sort();
        h.summary = firstSentence(item.v.tool.description);
        h.use = `call ${item.id} directly, with "host": one of ${hosts.slice(0, 10).join(', ')}${hosts.length > 10 ? `, … (${hosts.length})` : ''}`;
      }
      return h;
    });
    return { content: [{ type: 'text', text: searchText(query, hits, undefined) }] };
  };

// ... rest of the file ...

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const clientForPrompt = promptToClientMap.get(name);

    if (!clientForPrompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }

    try {
      logger.log('Forwarding prompt request:', name);

      const response = await clientForPrompt.client.request(
        {
          method: 'prompts/get' as const,
          params: {
            name,
            arguments: request.params.arguments || {},
            _meta: request.params._meta || {
              progressToken: undefined
            }
          }
        },
        GetPromptResultSchema
      );

      logger.log('Prompt result:', response);
      return response;
    } catch (error: any) {
      const errorMessage = `Error getting prompt '${name}' from backend server '${clientForPrompt.name}': ${stripMcpPrefix(error.message || 'An unknown error occurred')}`;
      logger.error(errorMessage, error);
      throw new Error(errorMessage);
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    logger.log("Received prompts/list request - returning from cached map");
    // Directly use the pre-populated map
    const allPrompts: Prompt[] = [];
     for (const [name, connectedClient] of promptToClientMap.entries()) {
         // Similar simplification as tools/list
         allPrompts.push({
             name: name, // The map key is the original name
             description: `[${connectedClient.name}] Prompt (details omitted in list)`,
         });
        }
       logger.log(`Returning ${allPrompts.length} prompts from map.`);
       return {
         prompts: allPrompts,
      nextCursor: undefined // Caching doesn't support pagination easily here
    };
  });

   server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
       logger.log("Received resources/list request - returning from cached map");
       const allResources: Resource[] = [];
       for (const [uri, connectedClient] of resourceToClientMap.entries()) {
           // Simplified response
           allResources.push({
               uri: uri,
               name: `[${connectedClient.name}] Resource (details omitted in list)`,
               description: undefined,
           });
       }
       logger.log(`Returning ${allResources.length} resources from map.`);
       return {
           resources: allResources,
           nextCursor: undefined // Caching doesn't support pagination easily here
       };
   });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    // This logic remains the same, using the map
    const { uri } = request.params;
    const clientForResource = resourceToClientMap.get(uri);

    if (!clientForResource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    try {
      return await clientForResource.client.request(
        {
          method: 'resources/read',
          params: {
            uri,
            _meta: request.params._meta
          }
        },
        ReadResourceResultSchema
      );
    } catch (error: any) {
      const errorMessage = `Error reading resource '${uri}' from backend server '${clientForResource.name}': ${stripMcpPrefix(error.message || 'An unknown error occurred')}`;
      logger.error(errorMessage, error);
      throw new Error(errorMessage);
    }
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    const allTemplates: ResourceTemplate[] = [];

    // Iterate over the correct client list
    for (const connectedClient of liveClients()) {
      try {
        const result = await connectedClient.client.request(
          {
            method: 'resources/templates/list' as const,
            params: {
              cursor: request.params?.cursor,
              _meta: request.params?._meta || {
                progressToken: undefined
              }
            }
          },
          ListResourceTemplatesResultSchema
        );

        if (result.resourceTemplates) {
          // Add explicit type for template parameter
          const templatesWithSource = result.resourceTemplates.map((template: ResourceTemplate) => ({ // FIX: Ensure type is present
            ...template,
            name: `[${connectedClient.name}] ${template.name || ''}`,
            description: template.description ? `[${connectedClient.name}] ${template.description}` : undefined
          }));
          allTemplates.push(...templatesWithSource);
        }
      } catch (error: any) {
        const isMethodNotFoundError = error?.name === 'McpError' && error?.code === -32601;

        if (isMethodNotFoundError) {
          logger.warn(`Warning: Method 'resources/templates/list' not found on server ${connectedClient.name}. Proceeding without templates from this source.`);
        } else {
          // Standardize error propagation for other errors
          const errorMessage = `Error fetching resource templates from backend server '${connectedClient.name}': ${error.message || 'An unknown error occurred'}`;
          logger.error(errorMessage, error); // Log the detailed error
          // We are in a loop, so we might not want to throw and stop the whole process.
          // Instead, we log the error and continue to try fetching from other clients.
          // If we needed to inform the client that partial data occurred, we'd need a different strategy.
          // For now, just logging and continuing. If *all* sources fail, the client gets an empty list.
        }
      }
    }

    return {
      resourceTemplates: allTemplates,
      nextCursor: request.params?.cursor
    };
  });

  return server;
}
