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
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { createClients, ConnectedClient, reconnectSingleClient } from './client.js';
import { logger } from './logger.js';
import { Config, loadConfig, TransportConfig, isSSEConfig, isStdioConfig, isHttpConfig, ToolConfig, loadToolConfig, DEFAULT_SERVER_TOOLNAME_SEPERATOR } from './config.js';
import * as eventsource from 'eventsource';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { recordToolCall, recordRateLimit } from './audit.js';
import { UNKNOWN_IDENTITY, type CallerIdentity } from './identity.js';
import { currentPolicy, AUTHZ_DENIED_CODE, type AuthzDecision } from './policy.js';
import { checkTrifecta, configureTrifecta, summarizeClassification, selfCompletingTools, TRIFECTA_BLOCKED_CODE, type TrifectaDecision } from './trifecta.js';
import { shapeToolResult } from './tool-result.js';
import { RATE_LIMIT_ENABLED, RATE_LIMITED_CODE, TOOL_CALL_LIMIT, toolCallLimiter, rateKey, rateLimitErrorData, rateLimitMessage } from './ratelimit.js';

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
const UI_LAYOUT_PATH = path.resolve(__mcpProxyDirname, '..', 'config', 'ui_layout.json');

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
export const updateBackendConnections = async (newServerConfig: Config, newToolConfig: ToolConfig) => {
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
    // Every other still-configured client is kept untouched.
    const clientsToReplace = currentConnectedClients.filter(c =>
        newClientKeys.has(c.name) && stableConfigString(c.config) !== stableConfigString(activeServersConfigLocal[c.name]));
    const replaceKeys = new Set(clientsToReplace.map(c => c.name));

    const clientsToRemove = currentConnectedClients.filter(c => !newClientKeys.has(c.name) || replaceKeys.has(c.name));
    const clientsToKeep = currentConnectedClients.filter(c => newClientKeys.has(c.name) && !replaceKeys.has(c.name));
    const keysToAdd = Object.keys(activeServersConfigLocal).filter(key => !currentClientKeys.has(key) || replaceKeys.has(key));

    logger.log(`Clients to replace (config changed): ${clientsToReplace.map(c => c.name).join(', ') || 'None'}`);
    logger.log(`Clients to remove: ${clientsToRemove.map(c => c.name).join(', ') || 'None'}`);
    logger.log(`Clients to keep: ${clientsToKeep.map(c => c.name).join(', ') || 'None'}`);
    logger.log(`Server keys to add: ${keysToAdd.join(', ') || 'None'}`);

    // 1. Cleanup removed clients
    if (clientsToRemove.length > 0) {
        logger.log(`Cleaning up ${clientsToRemove.length} removed clients...`);
        await Promise.all(clientsToRemove.map(async ({ name, cleanup }) => {
            try {
                await cleanup();
                logger.log(`  Cleaned up client: ${name}`);
            } catch (error: any) {
                logger.error(`  Error cleaning up client ${name}: ${error.message}`);
            }
        }));
    }

    // 2. Connect new clients
    let newlyConnectedClients: ConnectedClient[] = [];
    if (keysToAdd.length > 0) {
        const configToAdd: Record<string, TransportConfig> = {};
        keysToAdd.forEach(key => { configToAdd[key] = activeServersConfigLocal[key]; });
        logger.log(`Connecting ${keysToAdd.length} new clients...`);
        newlyConnectedClients = await createClients(configToAdd);
        logger.log(`Successfully connected to ${newlyConnectedClients.length} out of ${keysToAdd.length} new clients.`);
    }

    // 3. Update the main list
    currentConnectedClients = [...clientsToKeep, ...newlyConnectedClients];
    logger.log(`Total active clients after update: ${currentConnectedClients.length}`);

    // 4. Clear and repopulate maps immediately (important for consistency)
    logger.log("Clearing and repopulating internal maps (tools, resources, prompts)...");
    toolToClientMap.clear();
    resourceToClientMap.clear();
    promptToClientMap.clear();

    // Repopulate Tools Map
    for (const connectedClient of currentConnectedClients) {
        try {
            const result = await connectedClient.client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
            if (result.tools && result.tools.length > 0) {
                for (const tool of result.tools) {
                    const qualifiedName = `${connectedClient.name}${currentSeparator}${tool.name}`; // Use the current separator
                    const toolSettings = currentToolConfig.tools[qualifiedName];
                    const isEnabled = !toolSettings || toolSettings.enabled !== false;
                    if (isEnabled) {
                        // Store the client and the full tool info from the backend
                        toolToClientMap.set(qualifiedName, { client: connectedClient, toolInfo: tool });
                    }
                }
            }
        } catch (error: any) {
             if (!(error?.name === 'McpError' && error?.code === -32601)) { // Ignore 'Method not found'
                 logger.error(`Error fetching tools from ${connectedClient.name} during map update:`, error?.message || error);
             }
        }
    }
    logger.log(`  Updated tool map with ${toolToClientMap.size} enabled tools.`);

    // Repopulate Resources Map
    for (const connectedClient of currentConnectedClients) {
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
    for (const connectedClient of currentConnectedClients) {
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
};

export async function refreshBackendConnection(serverKey: string, serverConfig: TransportConfig): Promise<boolean> {
  logger.log(`Attempting to refresh backend connection for server: ${serverKey}`);
  const existingClientIndex = currentConnectedClients.findIndex(c => c.name === serverKey);
  let oldCleanup: (() => Promise<void>) | undefined = undefined;
  let existingConfig: TransportConfig | undefined = currentConnectedClients[existingClientIndex]?.config;

  if (existingClientIndex !== -1 && currentConnectedClients[existingClientIndex]) {
    oldCleanup = currentConnectedClients[existingClientIndex].cleanup;
    existingConfig = currentConnectedClients[existingClientIndex].config;
  } else {
    // Fallback to currentActiveServersConfig if not found in currentConnectedClients (should be rare for refresh)
    existingConfig = currentActiveServersConfig[serverKey];
  }

  if (!existingConfig) {
    logger.error(`Configuration for server ${serverKey} not found. Cannot refresh.`);
    return false;
  }
  // Use the passed serverConfig if available (e.g. from initial load), otherwise fallback to existingConfig.
  // The `serverConfig` parameter in refreshBackendConnection might be more up-to-date if called during a config reload.
  const configToUse = serverConfig || existingConfig;


  try {
    // reconnectSingleClient returns Omit<ConnectedClient, 'name'>
    const reconnectedClientParts = await reconnectSingleClient(serverKey, configToUse, oldCleanup);

    const newConnectedClientEntry: ConnectedClient = {
      ...reconnectedClientParts, // Spread the parts (client, cleanup, config, transportType)
      name: serverKey, // Add the name back
    };

    if (existingClientIndex !== -1) {
      currentConnectedClients[existingClientIndex] = newConnectedClientEntry;
      logger.log(`Updated existing client entry for ${serverKey} in currentConnectedClients.`);
    } else {
      currentConnectedClients.push(newConnectedClientEntry);
      logger.log(`Added new client entry for ${serverKey} to currentConnectedClients (this path might be taken if client was previously removed due to error).`);
    }

    // Clear existing entries for this client
    for (const [key, value] of toolToClientMap.entries()) {
      if (value.client.name === serverKey) {
        toolToClientMap.delete(key);
      }
    }
    for (const [key, value] of resourceToClientMap.entries()) {
      // Assuming value is ConnectedClient, so value.name is the server key
      if (value.name === serverKey) {
        resourceToClientMap.delete(key);
      }
    }
    for (const [key, value] of promptToClientMap.entries()) {
      // Assuming value is ConnectedClient, so value.name is the server key
      if (value.name === serverKey) {
        promptToClientMap.delete(key);
      }
    }
    logger.log(`Cleared map entries for ${serverKey}.`);

    // Repopulate maps for the reconnected client
    const connectedClient = newConnectedClientEntry;
    try {
        const result = await connectedClient.client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
        if (result.tools && result.tools.length > 0) {
            for (const tool of result.tools) {
                const qualifiedName = `${connectedClient.name}${currentSeparator}${tool.name}`; // Use the current separator
                const toolSettings = currentToolConfig.tools[qualifiedName];
                const isEnabled = !toolSettings || toolSettings.enabled !== false;
                if (isEnabled) {
                    toolToClientMap.set(qualifiedName, { client: connectedClient, toolInfo: tool });
                }
            }
        }
    } catch (error: any) {
         if (!(error?.name === 'McpError' && error?.code === -32601)) {
             logger.error(`Error fetching tools from ${connectedClient.name} during refresh:`, error?.message || error);
         }
    }

    try {
         const result = await connectedClient.client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema);
         if (result.resources) {
             result.resources.forEach(resource => resourceToClientMap.set(resource.uri, connectedClient));
         }
     } catch (error: any) {
          if (!(error?.name === 'McpError' && error?.code === -32601)) {
              logger.error(`Error fetching resources from ${connectedClient.name} during refresh:`, error?.message || error);
          }
     }

    try {
         const result = await connectedClient.client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema);
         if (result.prompts) {
             result.prompts.forEach(prompt => promptToClientMap.set(prompt.name, connectedClient));
         }
     } catch (error: any) {
          if (!(error?.name === 'McpError' && error?.code === -32601)) {
              logger.error(`Error fetching prompts from ${connectedClient.name} during refresh:`, error?.message || error);
          }
     }
    logger.log(`Repopulated maps for ${serverKey}.`);
    return true;

  } catch (error: any) {
    logger.error(`Failed to refresh backend connection for ${serverKey}: ${error.message}`);
    // If refresh failed, we remove the client to prevent further attempts with a known bad state.
    // This also cleans up its entries from the maps.
    if (existingClientIndex !== -1) {
        currentConnectedClients.splice(existingClientIndex, 1);
    }
    // Clear any potentially lingering map entries if refresh failed mid-way
    for (const [key, value] of toolToClientMap.entries()) {
      if (value.client.name === serverKey) toolToClientMap.delete(key);
    }
    for (const [key, value] of resourceToClientMap.entries()) {
      if (value.name === serverKey) resourceToClientMap.delete(key);
    }
    for (const [key, value] of promptToClientMap.entries()) {
      if (value.name === serverKey) promptToClientMap.delete(key);
    }
    logger.log(`Removed client ${serverKey} and its map entries after failed refresh.`);
    return false;
  }
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
    await Promise.all(currentConnectedClients.map(async ({ name, cleanup: clientCleanup }) => {
        try {
            await clientCleanup();
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
      version: "1.0.0", // Consider updating version dynamically
    },
    {
      capabilities: {
        prompts: {},
        resources: { subscribe: true },
        tools: {},
      },
    },
  );

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

    for (const [originalQualifiedName, { client: connectedClient, toolInfo }] of toolToClientMap.entries()) {
        if (policy.configured && !policy.decide({ identity, backend: connectedClient.name, tool: toolInfo.name }).allowed) {
            hidden++;
            continue;
        }
        const overrideSettings = toolOverrides[originalQualifiedName];

        // Determine the final name and description to expose
        // Use override if present, otherwise use original value
        const exposedName = overrideSettings?.exposedName || originalQualifiedName;
        const exposedDescription = overrideSettings?.exposedDescription || toolInfo.description;

        // Construct the Tool object for the response
        collected.push({
            key: originalQualifiedName,
            tool: {
                name: exposedName, // Use the final exposed name
                description: exposedDescription, // Use the final exposed description
                inputSchema: toolInfo.inputSchema, // Schema is never overridden
            },
        });
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
    logger.log(`Returning ${enabledTools.length} enabled tools with applied overrides (ordered: ${ranks.size} from layout, rest alphabetical)${policy.configured ? `; ${hidden} hidden by tool policy for ${identity.kind}:${identity.username}` : ''}.`);
    return { tools: enabledTools };
  });

  // Filled in as the call is resolved, so an audit line can still name the tool
  // key and backend for a call that resolved and then failed.
  interface ToolCallAuditCtx { toolKey?: string; backend?: string; authz?: AuthzDecision; trifecta?: TrifectaDecision['detail'] }

  const forwardToolCall = async (request: any, audit: ToolCallAuditCtx, identity: CallerIdentity, sessionId?: string): Promise<any> => {
    const { name: requestedExposedName, arguments: args } = request.params;
    let originalQualifiedName: string | undefined;
    let mapEntry: { client: ConnectedClient, toolInfo: Tool } | undefined;

    // Need to find the original tool based on the potentially overridden exposed name
    const toolOverrides = currentToolConfig.tools || {};

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

    // If no entry was found after checking all enabled tools and their potential overrides
    if (!mapEntry || !originalQualifiedName) {
        const errorMessage = `Attempted to call tool with exposed name "${requestedExposedName}", but no corresponding enabled tool or override configuration found.`;
        logger.error(errorMessage);
        throw new McpError(-32601, errorMessage); // Method not found error code
    }

    // Now we have the correct mapEntry and the originalQualifiedName
    let { client: clientForTool, toolInfo } = mapEntry; // toolInfo here is the correct one from the found mapEntry
    const originalToolNameForBackend = toolInfo.name; // The actual name the backend server expects (from the original toolInfo)

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
        throw new McpError(AUTHZ_DENIED_CODE, `Tool "${requestedExposedName}" is not permitted for this caller.`);
    }

    // Lethal trifecta (trifecta.ts): authorization says this caller may use the
    // tool; this says whether this *session* may use it now, given what it has
    // already touched. After authz, so a call the caller may not make at all is
    // never counted against the session. Before forwarding, so a refused call
    // never reaches the backend. Synchronous from here to the check-and-record.
    const trifecta = checkTrifecta(sessionId, identity, clientForTool.name, originalToolNameForBackend, policy.trifecta);
    audit.trifecta = trifecta.detail;
    if (!trifecta.allowed) {
        throw new McpError(TRIFECTA_BLOCKED_CODE, trifecta.message || 'Blocked by lethal-trifecta policy', { trifecta: trifecta.detail });
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

    // Loop includes the initial attempt (attempt 0) plus maxRetries
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt >= 0) {            
            if (attempt > 0) {
              const delay = retryDelayBaseMs * Math.pow(2, attempt - 1) + (Math.random() * retryDelayBaseMs * 0.5);
              logger.log(`Tool call failed for '${requestedExposedName}'. Attempt ${attempt}/${maxRetries}. Retrying in ${delay.toFixed(0)}ms...`);
              await sleep(delay);
            }
            // For SSE, attempt reconnect before retrying the call if the last error was a connection error
            // For SSE, attempt reconnect before retrying the call if the last error was a connection error OR if it's the first attempt
            if (clientForTool.transportType === 'sse') {
                if (attempt === 0 || isConnectionError(lastError)) { // Force reconnect on first attempt for SSE, or if there was a connection error
                    logger.log(`SSE connection handling for tool '${requestedExposedName}' on server '${clientForTool.name}'. Attempting reconnect.`);
                    const clientTransportConfig = currentActiveServersConfig[clientForTool.name];
                    if (!clientTransportConfig) {
                        logger.error(`Cannot proceed with SSE: TransportConfig for server '${clientForTool.name}' not found.`);
                        throw new McpError(-32000, `SSE TransportConfig for server '${clientForTool.name}' not found for tool '${requestedExposedName}'.`);
                    }
                    const refreshed = await refreshBackendConnection(clientForTool.name, clientTransportConfig);
                    if (refreshed) {
                        logger.log(`Successfully reconnected to server '${clientForTool.name}' via SSE.`);
                        // Update clientForTool and toolInfo references after refresh
                        const newMapEntry = toolToClientMap.get(originalQualifiedName);
                        if (!newMapEntry) {
                            logger.error(`Tool '${originalQualifiedName}' not found in map after successful SSE refresh for server '${clientForTool.name}'.`);
                            throw new McpError(-32000, `Tool '${originalQualifiedName}' disappeared after SSE refresh for server '${clientForTool.name}'.`);
                        }
                        clientForTool = newMapEntry.client;
                        toolInfo = newMapEntry.toolInfo;
                        audit.backend = clientForTool.name;
                    } else {
                        logger.error(`SSE Reconnection to server '${clientForTool.name}' failed.`);
                        throw new McpError(-32000, `SSE Reconnection to server '${clientForTool.name}' failed for tool '${requestedExposedName}'.`);
                    }
                }
            }
         }

        try {
            logger.log(`Forwarding tool call for exposed name '${requestedExposedName}' (original qualified name: '${originalQualifiedName}'). Forwarding to server '${clientForTool.name}' as tool '${originalToolNameForBackend}' (Attempt ${attempt + 1})`);
            // Explicitly set a timeout for the request using SDK's RequestOptions
            const backendResponse = await clientForTool.client.request(
                {
                    method: 'tools/call',
                    params: { name: originalToolNameForBackend, arguments: args || {}, _meta: { progressToken: request.params._meta?.progressToken } }
                },
                CompatibilityCallToolResultSchema,
                { timeout: DEFAULT_REQUEST_TIMEOUT_MSEC } // Set timeout explicitly
            );
            logger.log(`[Tool Call] Backend response received for '${requestedExposedName}'. Passing to SDK Server.`);
            return backendResponse; // Success! Return the response.
        } catch (error: any) {
            lastError = error;
            logger.warn(`Attempt ${attempt + 1} to call tool '${requestedExposedName}' failed: ${error.message}`);

            // Check if this error warrants a retry based on type and configuration
            const isRetryableError = isConnectionError(error) || (error?.name === 'McpError' && error?.code === -32001); // Consider timeout as retryable
            const shouldRetry = (clientForTool.transportType === 'sse' && currentProxyConfig.retrySseToolCall && isRetryableError) || // Check retrySseToolCall
                                (clientForTool.transportType === 'stdio' && currentProxyConfig.retryStdioToolCall && isRetryableError) ||
                                (clientForTool.transportType === 'http' && currentProxyConfig.retryHttpToolCall && isRetryableError);


            if (!shouldRetry && attempt === 0) {
                 // If it's the first attempt and not a retryable error type, re-throw immediately
                 logger.error(`Tool call for '${requestedExposedName}' failed with non-retryable error on first attempt: ${error.message}`, error);
                 // If the error is already an McpError, re-throw it directly. Otherwise, wrap it.
                 if (error instanceof McpError) {
                     throw error;
                 } else {
                     throw new McpError(error?.code || -32000, error.message || 'An unknown error occurred', error?.data);
                 }
            }

             if (!shouldRetry && attempt > 0) {
                 // If it's a subsequent attempt and the error is no longer retryable (e.g., backend returned a specific error after reconnect)
                 logger.error(`Tool call for '${requestedExposedName}' failed with non-retryable error after retries: ${error.message}`, error);
                 // If the error is already an McpError, re-throw it directly. Otherwise, wrap it.
                 if (error instanceof McpError) {
                     throw error;
                 } else {
                     throw new McpError(error?.code || -32000, error.message || 'An unknown error occurred', error?.data);
                 }
            }

            // If it's a retryable error and we are within maxRetries, the loop continues.
            // If it's a retryable error but we are at maxRetries, the loop will exit after this iteration.
        }
    }

    // If the loop finishes without returning, it means all retries failed.
    const errorMessage = `Error calling tool '${requestedExposedName}' after ${maxRetries} retries (on backend server '${clientForTool.name}', original tool name '${originalToolNameForBackend}'): ${lastError?.message || 'An unknown error occurred'}`;
    logger.error(errorMessage, lastError);
    // Ensure a structured McpError is returned to the client
    throw new McpError(lastError?.code || -32000, errorMessage, lastError?.data);
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
        throw new McpError(RATE_LIMITED_CODE, rateLimitMessage(identity, data), data);
      }
    }

    try {
      const result = await forwardToolCall(request, audit, identity, sessionId);
      // A backend can report failure in-band via isError rather than throwing.
      const inBandError = result?.isError === true;
      recordToolCall({
        identity, sessionId, tool: toolName, toolKey: audit.toolKey, backend: audit.backend,
        ok: !inBandError,
        durationMs: Date.now() - startedAt,
        authz: audit.authz,
        ...(audit.trifecta ? { trifecta: audit.trifecta } : {}),
        ...(inBandError ? { errorMessage: 'backend returned isError' } : {}),
        arguments: request.params.arguments,
      });
      // Last, so the audit record above describes what the backend returned.
      return shapeToolResult(result, identity);
    } catch (err: any) {
      recordToolCall({
        identity, sessionId, tool: toolName, toolKey: audit.toolKey, backend: audit.backend,
        ok: false,
        durationMs: Date.now() - startedAt,
        authz: audit.authz,
        ...(audit.trifecta ? { trifecta: audit.trifecta } : {}),
        errorCode: err?.code,
        errorMessage: err?.message,
        arguments: request.params.arguments,
      });
      throw err;
    }
  });

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
      const errorMessage = `Error getting prompt '${name}' from backend server '${clientForPrompt.name}': ${error.message || 'An unknown error occurred'}`;
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
      const errorMessage = `Error reading resource '${uri}' from backend server '${clientForResource.name}': ${error.message || 'An unknown error occurred'}`;
      logger.error(errorMessage, error);
      throw new Error(errorMessage);
    }
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    const allTemplates: ResourceTemplate[] = [];

    // Iterate over the correct client list
    for (const connectedClient of currentConnectedClients) { // FIX: Use currentConnectedClients
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
