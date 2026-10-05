import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport, StreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/streamableHttp.js"; // Import StreamableHTTPServerTransport and options
import express, { Request, Response, NextFunction } from "express";
import session from 'express-session';
import { ServerResponse } from "node:http"; // Import ServerResponse
import { readFile, writeFile, access, mkdir, stat } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { exec as execCallback, spawn } from 'child_process'; // Import spawn
import { promisify } from 'util';
// Import the necessary functions from mcp-proxy and config
import { createServer, updateBackendConnections, getCurrentProxyState, refreshBackendConnection, setSessionIdentity, clearSessionIdentity, getSessionIdentity } from "./mcp-proxy.js";
import { resolveIdentity, ANONYMOUS_IDENTITY, UNKNOWN_IDENTITY, type CallerIdentity } from './identity.js';
import { compilePolicy, readPolicyFile, writePolicyFile, TOOL_POLICY_PATH } from './policy.js';
import { auditConfigSummary, recordRateLimit, flushRateLimitAudit, auditDrained } from './audit.js';
import { mergeTextContentConfigSummary } from './tool-result.js';
import { RATE_LIMIT_ENABLED, RATE_LIMITED_CODE, HTTP_LIMIT, httpLimiter, toolCallLimiter, rateKey, rateLimitErrorData, rateLimitMessage, rateLimitConfigSummary } from './ratelimit.js';
import { clearSessionTrifecta } from './trifecta.js';
import http from 'http';
import { fileURLToPath } from 'url';
// Import JSONRPCMessage and JSONRPCError from types
import { Tool, ListToolsResultSchema, JSONRPCMessage, JSONRPCError } from "@modelcontextprotocol/sdk/types.js";
// Import loadToolConfig as well
import { Config, loadConfig, isStdioConfig, loadToolConfig } from './config.js';
import { logger } from './logger.js';
import { pathDefault } from './paths.js';
// Import terminal router and related types/variables for shutdown
import { terminalRouter, activeTerminals, TERMINAL_OUTPUT_SSE_CONNECTIONS, ActiveTerminal } from './terminal.js';
import { loadUsers, saveUsers, generateToken, UserRecord } from './users.js';
import { listMailAccountsSafe, upsertMailAccount, deleteMailAccount, testMailAccountConnection, validateAccountName } from './mailAccounts.js';
import { deployKeyToHost, getGatewayPublicKey, PRIVATE_KEY_PATH } from './deployKey.js';
import archiver from 'archiver';

// Directory holding the prebuilt Windows client installer payload (portable node,
// pre-installed mcp-remote, install scripts). Built by installer-base/build-base.sh.
// Pre-rename default /opt/mcp-proxy-installer-base is still used when it exists.
const INSTALLER_BASE_DIR = pathDefault('INSTALLER_BASE_DIR', '/opt/patchbay-installer-base', '/opt/mcp-proxy-installer-base');

// A server key names a directory under the tools folder, so it must not be able to
// climb out of it. Same shape the admin UI already generates for new entries.
const SERVER_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Package managers and fetchers an install step is allowed to invoke. Anything
// else (sh, bash, curl piped to a shell, ...) is refused -- see the spawn call
// in the install route for why the shell is gone entirely.
const INSTALL_COMMAND_ALLOWLIST = new Set([
    'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx',
    'pip', 'pip3', 'python', 'python3', 'uv', 'uvx', 'poetry',
    'git', 'go', 'cargo', 'make',
]);

/**
 * Split a command string into argv the way a shell would, honouring single and
 * double quotes and backslash escapes, without handing the string to a shell.
 * Metacharacters (&& | > ; $) carry no special meaning here -- they end up as
 * literal argument text, which the allowlist above then refuses.
 */
function tokenizeCommand(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let started = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (ch === '\\' && quote !== "'" && i + 1 < command.length) {
            current += command[++i];
            started = true;
        } else if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
        } else if (/\s/.test(ch)) {
            if (started) { tokens.push(current); current = ''; started = false; }
        } else {
            current += ch;
            started = true;
        }
    }
    if (started) tokens.push(current);
    return tokens;
}

// Default MCP server name used in generated client configs / installers -- lets
// each gateway self-brand (e.g. 'lab' vs 'prod'). The admin UI reads this
// via /admin/environment and pre-fills the "Server name" box; the installer
// endpoint uses it when no explicit ?name= is given.
const GATEWAY_CLIENT_NAME = process.env.GATEWAY_CLIENT_NAME || 'patchbay';

// Optional accent color (any CSS color, e.g. "#842029") for the admin UI header,
// so admins juggling several IP-only gateway tabs can tell them apart at a glance.
const GATEWAY_UI_COLOR = process.env.GATEWAY_UI_COLOR || '';

const exec = promisify(execCallback);

declare module 'express-session' {
  interface SessionData {
    user?: { username: string };
  }
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const expressServer = http.createServer(app);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'mcp_server.json');
const TOOL_CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'tool_config.json');
const SECRET_FILE_PATH = path.resolve(__dirname, '..', 'config', '.session_secret');
const CATALOG_PATH = path.resolve(__dirname, '..', 'config', 'catalog.json');
const REQUESTS_PATH = path.resolve(__dirname, '..', 'config', 'requests.json');
// Cosmetic admin-UI layout (server/tool ordering + collapsible groups). Display-only,
// does not affect MCP operation. Per-gateway.
const UI_LAYOUT_PATH = path.resolve(__dirname, '..', 'config', 'ui_layout.json');
// npm registry search that powers the "external" (browse-only) catalog. Everything
// it returns is npx-runnable. Query is overridable; results are cached.
const EXTERNAL_REGISTRY_QUERY = process.env.EXTERNAL_REGISTRY_QUERY || 'mcp server';
const EXTERNAL_REGISTRY_SIZE = parseInt(process.env.EXTERNAL_REGISTRY_SIZE || '50', 10);
let externalCache: { fetchedAt: number; items: any[] } | null = null;
const EXTERNAL_TTL_MS = 60 * 60 * 1000; // 1h
const REGISTRY_URL = process.env.MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io/v0/servers';
const REGISTRY_MAX_PAGES = parseInt(process.env.MCP_REGISTRY_MAX_PAGES || '6', 10); // ~600 entries
const ICON_CACHE_DIR = path.resolve(__dirname, '..', 'config', 'icon-cache');
const ICON_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const publicPath = path.join(__dirname, '..', 'public');

// Starter registry of well-known, npx-runnable MCP servers surfaced in the admin
// UI's "Browse Catalog". Editable per-gateway by dropping a config/catalog.json
// (same shape) next to the other config files; that overrides this default.
const DEFAULT_CATALOG = [
    {
        name: 'filesystem', package: '@modelcontextprotocol/server-filesystem',
        description: 'Read and write files under directories you explicitly allow.',
        args: ['/path/to/allow'], env: [], needsConfig: true, category: 'Files', repoOwner: 'modelcontextprotocol'
    },
    {
        name: 'memory', package: '@modelcontextprotocol/server-memory',
        description: 'A persistent knowledge-graph memory the model can read and update.',
        args: [], env: [], needsConfig: false, category: 'Knowledge', repoOwner: 'modelcontextprotocol'
    },
    {
        name: 'sequential-thinking', package: '@modelcontextprotocol/server-sequential-thinking',
        description: 'A structured scratchpad for step-by-step reasoning.',
        args: [], env: [], needsConfig: false, category: 'Reasoning', repoOwner: 'modelcontextprotocol'
    },
    {
        name: 'everything', package: '@modelcontextprotocol/server-everything',
        description: 'Reference server that exercises every MCP feature — handy for testing the gateway.',
        args: [], env: [], needsConfig: false, category: 'Testing', repoOwner: 'modelcontextprotocol'
    }
];

// Curated allowlist (config/catalog.json, else the built-in default). These are the
// only connectors that can actually be installed — the governance gate.
async function loadCurated(): Promise<any[]> {
    try {
        const raw = await readFile(CATALOG_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through to default */ }
    return DEFAULT_CATALOG;
}
async function saveCurated(items: any[]): Promise<void> {
    await writeFile(CATALOG_PATH, JSON.stringify(items, null, 2), 'utf-8');
}
async function addToCurated(entry: any): Promise<{ added: boolean; catalog: any[] }> {
    const curated = await loadCurated();
    const key = (entry.package || entry.name || '').toLowerCase();
    if (curated.some(c => (c.package || c.name || '').toLowerCase() === key)) {
        return { added: false, catalog: curated };
    }
    const clean: any = {
        name: entry.name || (entry.package || '').split('/').pop(),
        package: entry.package || '',
        description: entry.description || '',
        args: Array.isArray(entry.args) ? entry.args : [],
        env: Array.isArray(entry.env) ? entry.env : [],
        needsConfig: !!entry.needsConfig,
        category: entry.category || 'External'
    };
    if (entry.repoOwner) clean.repoOwner = entry.repoOwner;
    if (entry.installType) clean.installType = entry.installType;
    if (entry.url) clean.url = entry.url;
    const next = [...curated, clean];
    await saveCurated(next);
    return { added: true, catalog: next };
}

// Extract a GitHub owner from a repository URL (for the cached-avatar icon).
function ghOwnerFromRepo(url?: string): string | undefined {
    if (!url) return undefined;
    const m = url.match(/github\.com[/:]([^/]+)/i);
    if (!m) return undefined;
    const owner = m[1].replace(/[^A-Za-z0-9-]/g, '');
    return owner || undefined;
}
async function fetchJson(url: string, ms = 8000): Promise<any> {
    const doFetch: any = (globalThis as any).fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const resp = await doFetch(url, { signal: ctrl.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } finally { clearTimeout(timer); }
}

// Official MCP registry — installable entries (npm packages + remote URLs), paged.
async function fetchRegistry(): Promise<any[]> {
    const out: any[] = [];
    let cursor = '';
    for (let i = 0; i < REGISTRY_MAX_PAGES; i++) {
        const url = `${REGISTRY_URL}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        let data: any;
        try { data = await fetchJson(url); } catch { break; }
        for (const e of (data.servers || [])) {
            const s = e.server || {};
            const npmPkg = (s.packages || []).find((p: any) => p.registryType === 'npm');
            const remote = (s.remotes || [])[0];
            const repoOwner = ghOwnerFromRepo((s.repository || {}).url);
            const shortName = (s.name || '').split('/').pop();
            const base = { name: shortName, description: s.description || s.title || '', source: 'registry', repoOwner };
            if (npmPkg) out.push({ ...base, package: npmPkg.identifier, installType: 'npm' });
            else if (remote && remote.url) out.push({ ...base, package: '', url: remote.url, installType: remote.type === 'sse' ? 'sse' : 'http' });
            // pypi / oci skipped: not installable via this gateway's wizard
        }
        cursor = (data.metadata || {}).nextCursor || '';
        if (!cursor) break;
    }
    return out;
}

// npm registry search — broadens coverage beyond the official registry.
async function fetchNpmSearch(): Promise<any[]> {
    try {
        const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(EXTERNAL_REGISTRY_QUERY)}&size=${EXTERNAL_REGISTRY_SIZE}`;
        const data = await fetchJson(url);
        return (data.objects || []).map((o: any) => {
            const p = o.package || {};
            return {
                name: (p.name || '').split('/').pop(),
                package: p.name,
                description: p.description || '',
                source: 'npm',
                installType: 'npm',
                repoOwner: ghOwnerFromRepo(p.links && p.links.repository),
            };
        }).filter((x: any) => x.package);
    } catch { return []; }
}

// Blended, browse-only external catalog: official registry + npm search, deduped.
// Cached; empty on total failure so browsing still works from the curated list.
async function fetchExternalCatalog(): Promise<any[]> {
    if (externalCache && (Date.now() - externalCache.fetchedAt) < EXTERNAL_TTL_MS) {
        return externalCache.items;
    }
    const [reg, npm] = await Promise.all([fetchRegistry(), fetchNpmSearch()]);
    const seen = new Set<string>();
    const items: any[] = [];
    for (const e of [...reg, ...npm]) {
        const key = (e.package || e.url || e.name || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(e);
    }
    logger.log(`External catalog: ${reg.length} registry + ${npm.length} npm → ${items.length} unique.`);
    externalCache = { fetchedAt: Date.now(), items };
    return items;
}

// Cached, SSRF-safe connector icon: GitHub owner avatar only (fixed trusted host),
// stored on disk and served same-origin so the browser never calls out.
async function getIconBuffer(owner: string): Promise<Buffer | null> {
    const safe = owner.replace(/[^A-Za-z0-9-]/g, '');
    if (!safe) return null;
    const file = path.join(ICON_CACHE_DIR, safe + '.png');
    try {
        const st = await stat(file);
        if ((Date.now() - st.mtimeMs) < ICON_TTL_MS) return await readFile(file);
    } catch { /* not cached / stale */ }
    try {
        const doFetch: any = (globalThis as any).fetch;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        let resp: any;
        try { resp = await doFetch(`https://github.com/${safe}.png?size=80`, { signal: ctrl.signal, redirect: 'follow' }); }
        finally { clearTimeout(timer); }
        if (!resp.ok) return null;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 500 * 1024) return null;
        await mkdir(ICON_CACHE_DIR, { recursive: true });
        await writeFile(file, buf);
        return buf;
    } catch { return null; }
}

// Connector requests filed by end-users (via the meta-tools backend) for admin review.
async function loadRequests(): Promise<any[]> {
    try {
        const raw = await readFile(REQUESTS_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
    } catch { /* none yet */ }
    return [];
}
async function saveRequests(items: any[]): Promise<void> {
    await writeFile(REQUESTS_PATH, JSON.stringify(items, null, 2), 'utf-8');
}

const sseTransports = new Map<string, SSEServerTransport>();
const streamableHttpTransports = new Map<string, StreamableHTTPServerTransport>();

// One Server (protocol) instance per client session, not one shared across all of
// them. A shared instance silently misroutes responses: Protocol.connect() sets
// `this._transport` and replies go back out through it, so the most recently
// connected client receives every other client's responses. On SDK 1.12.0 there is
// no guard against connecting twice, so this failed silently rather than throwing.
// Both gateways are multi-user, so this was live. See repro-session-bleed.mjs.
const { cleanup, createServerInstance } = await createServer();

interface ManagedSession {
    server: Awaited<ReturnType<typeof createServerInstance>>;
    lastActivity: number;
}
const activeSessions = new Map<string, ManagedSession>();

// Drop a session's server instance and forget it. Safe to call for an unknown id.
const disposeSession = (sessionId: string | undefined, reason: string) => {
    if (!sessionId) return;
    // Unconditional, and before the early return below: an identity must never
    // outlive the session it was resolved for, nor accumulate for sessions whose
    // server instance has already gone.
    clearSessionIdentity(sessionId);
    // Same rule for lethal-trifecta state: it belongs to this session id only.
    clearSessionTrifecta(sessionId);
    const session = activeSessions.get(sessionId);
    if (!session) return;
    activeSessions.delete(sessionId);
    session.server.close().catch((e: any) =>
        logger.warn(`Error closing server for session ${sessionId} (${reason}): ${e?.message || e}`));
};

const touchSession = (sessionId: string | undefined) => {
    if (!sessionId) return;
    const session = activeSessions.get(sessionId);
    if (session) session.lastActivity = Date.now();
};

// Reap sessions whose client vanished without a clean close. Without this, every
// dropped connection leaks a Server instance for the life of the process.
const SESSION_IDLE_TIMEOUT_MS = (Number(process.env.MCP_SESSION_IDLE_MINUTES) || 30) * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of [...activeSessions.entries()]) {
        if (now - session.lastActivity <= SESSION_IDLE_TIMEOUT_MS) continue;
        logger.log(`Session ${sessionId} idle for over ${SESSION_IDLE_TIMEOUT_MS / 60000} minutes; cleaning up.`);
        disposeSession(sessionId, 'idle');
        sseTransports.get(sessionId)?.close?.().catch(() => {});
        sseTransports.delete(sessionId);
        streamableHttpTransports.get(sessionId)?.close?.().catch(() => {});
        streamableHttpTransports.delete(sessionId);
    }
}, SESSION_SWEEP_INTERVAL_MS).unref();

// No longer creating a single mainHttpTransport at startup for /mcp.
// Transports for /mcp will be created dynamically per session.

const allowedKeysRaw = process.env.ALLOWED_KEYS || "";
const allowedKeys = new Set(allowedKeysRaw.split(',').map(k => k.trim()).filter(k => k.length > 0));

const allowedTokensRaw = process.env.ALLOWED_TOKENS || ""; // Renamed
const allowedTokens = new Set(allowedTokensRaw.split(',').map(t => t.trim()).filter(t => t.length > 0));

// Per-user tokens created via the admin UI (config/users.json) are layered on top
// of the static ALLOWED_TOKENS/ALLOWED_KEYS env vars, into the same live Sets that
// the /sse and /mcp auth checks read from -- so adding/revoking a user takes effect
// immediately, no restart required.
const existingUsers = await loadUsers();
for (const user of existingUsers) {
    allowedTokens.add(user.token);
    allowedKeys.add(user.token);
}

const authEnabled = allowedKeys.size > 0 || allowedTokens.size > 0;
logger.log(`MCP Endpoint Authentication: ${authEnabled ? `Enabled. ${allowedKeys.size} key(s) and ${allowedTokens.size} token(s) configured (including ${existingUsers.length} per-user token(s)).` : 'Disabled.'}`);
logger.log(auditConfigSummary());
logger.log(rateLimitConfigSummary());
logger.log(mergeTextContentConfigSummary());

/**
 * Resolve the caller behind an already-authenticated request.
 *
 * Called only after the membership check has passed, so this does not decide
 * access -- it decides attribution. The credential is read back off the request
 * the same way the auth check read it.
 */
async function identityForRequest(req: any): Promise<CallerIdentity> {
  if (!authEnabled) return ANONYMOUS_IDENTITY;
  const authHeader = req.headers['authorization'] as string | undefined;
  const bearer = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.substring('Bearer '.length).trim()
    : undefined;
  const key = (req.headers['x-api-key'] as string | undefined) || (req.query?.key as string | undefined);
  return resolveIdentity(bearer || key, [allowedTokens, allowedKeys]);
}

/**
 * Per-identity HTTP throttle for /mcp, /sse and /message (see ratelimit.ts).
 * Runs after authentication, so it only ever charges a known caller. When it
 * rejects, the 429 has already been sent and the caller must return.
 *
 * Deliberately no per-rejection logger line: a throttled loop would flood the
 * journal. The audit log gets a coalesced record instead.
 */
function rejectIfHttpRateLimited(req: Request, res: Response, identity: CallerIdentity, sessionId?: string): boolean {
  if (!RATE_LIMIT_ENABLED) return false;
  const key = rateKey(identity, req.ip || req.socket.remoteAddress);
  const decision = httpLimiter.take(key);
  if (decision.allowed) return false;

  const data = rateLimitErrorData('http', decision, HTTP_LIMIT);
  recordRateLimit({
    identity, sessionId, scope: 'http', key, method: req.method, path: req.path,
    errorCode: RATE_LIMITED_CODE, retryAfterMs: decision.retryAfterMs,
    burst: data.burst, perMinute: data.perMinute,
  });
  res.setHeader('Retry-After', String(data.retryAfterSeconds));
  res.status(429).json({
    jsonrpc: '2.0',
    error: { code: RATE_LIMITED_CODE, message: rateLimitMessage(identity, data), data },
    id: (req.body as any)?.id ?? null,
  });
  return true;
}

// Forget refilled buckets and write out coalesced rate-limit audit counts.
setInterval(() => {
  toolCallLimiter.sweep();
  httpLimiter.sweep();
  flushRateLimitAudit();
}, 5_000).unref();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';
const SESSION_SECRET_ENV = process.env.SESSION_SECRET; // Read from env

if (ADMIN_PASSWORD === 'password') {
    logger.warn("WARNING: Using default admin password. Set ADMIN_PASSWORD environment variable for security.");
}
// SESSION_SECRET warning is handled in getSessionSecret

// Read the ENABLE_ADMIN_UI environment variable.
const rawEnableAdminUI = process.env.ENABLE_ADMIN_UI;
// Enable Admin UI if ENABLE_ADMIN_UI is 'true' (case-insensitive), '1', or 'yes' (case-insensitive).
// Defaults to false if not set, empty, or any other value.
const enableAdminUI = typeof rawEnableAdminUI === 'string' && (rawEnableAdminUI.toLowerCase() === 'true' || rawEnableAdminUI === '1' || rawEnableAdminUI.toLowerCase() === 'yes');

async function getSessionSecret(): Promise<string> {
    if (SESSION_SECRET_ENV && SESSION_SECRET_ENV !== 'unsafe-default-secret' && SESSION_SECRET_ENV.trim() !== '') {
        logger.log("Using session secret from SESSION_SECRET environment variable.");
        return SESSION_SECRET_ENV;
    }

    try {
        await access(SECRET_FILE_PATH);
        const secretFromFile = await readFile(SECRET_FILE_PATH, 'utf-8');
        if (secretFromFile.trim() !== '') {
            logger.log("Read existing session secret from file.");
            return secretFromFile.trim();
        }
        // If file exists but is empty, proceed to generate a new one.
        logger.log("Session secret file exists but is empty. Generating a new one...");
    } catch (error: any) {
        if (error.code !== 'ENOENT') {
            logger.error("Error accessing session secret file, attempting to generate new:", error);
            // Proceed to generate new one if access failed for other reasons than not found
        } else {
            // File does not exist, normal path to generate new.
            logger.log("Session secret file not found. Generating a new one...");
        }
    }

    // Generate and save a new secret if not provided by env or valid file
    const newSecret = crypto.randomBytes(32).toString('hex');
    try {
        await mkdir(path.dirname(SECRET_FILE_PATH), { recursive: true });
        await writeFile(SECRET_FILE_PATH, newSecret, { encoding: 'utf-8', mode: 0o600 });
        logger.log(`New session secret generated and saved to ${SECRET_FILE_PATH}. It's recommended to set this value in the SESSION_SECRET environment variable for persistence across container restarts or deployments.`);
        return newSecret;
    } catch (writeError) {
        logger.error("FATAL: Could not write new session secret file:", writeError);
        logger.warn("WARNING: Falling back to a temporary, insecure session secret. Admin UI sessions will not persist.");
        return 'temporary-insecure-secret-' + crypto.randomBytes(16).toString('hex'); // Fallback, but not ideal
    }
}

// Map to store active Admin UI SSE connections, keyed by Express session ID
// Defined globally so it can be accessed by routes defined within the 'if (enableAdminUI)' block
const adminSseConnections = new Map<string, ServerResponse>();

if (enableAdminUI) {
    logger.log("Admin UI is ENABLED.");
    // Use global ADMIN_USERNAME and ADMIN_PASSWORD defined earlier.

    if (ADMIN_PASSWORD === 'password') { // Use global ADMIN_PASSWORD
        logger.warn("WARNING: Using default admin password. Set ADMIN_USERNAME and ADMIN_PASSWORD environment variables for security.");
    }

    const sessionSecret = await getSessionSecret();

    // How long an admin stays logged in, in hours. Configurable via ADMIN_SESSION_HOURS
    // (default 720 = 30 days). With rolling:true below, this window is refreshed on
    // every request, so an admin who uses the UI at least once per window never gets
    // logged out. Note: the session store is in-memory, so a *service restart* still
    // logs everyone out regardless of this value.
    const ADMIN_SESSION_HOURS = Number(process.env.ADMIN_SESSION_HOURS) || 720;

    app.use(session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        rolling: true, // reset the cookie's maxAge on each response so active sessions don't expire
        cookie: {
            // NOTE: intentionally driven by NODE_ENV, which these gateways leave
            // unset -- they are served over plain HTTP on a trusted network, and a
            // Secure cookie would never be sent back, silently breaking the admin
            // UI. See deploy/patchbay-gateway.env.example.
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            // The real CSRF defence here. The admin UI hands out a root PTY, so a
            // single forged cross-site POST from a logged-in admin's browser is
            // full root on this container. 'strict' stops the browser attaching
            // this cookie to *any* cross-site request. Safe because the admin UI
            // is same-origin with these routes, and MCP clients authenticate with
            // Bearer/X-Api-Key headers rather than this cookie.
            sameSite: 'strict',
            maxAge: 1000 * 60 * 60 * ADMIN_SESSION_HOURS
        }
    }));

    // Security response headers. Hand-rolled rather than pulling in helmet: the
    // gateway already carries a backlog of transitive npm advisories and this is
    // the whole useful subset for an admin UI on a trusted network. No CSP --
    // the admin pages rely on inline handlers and adding one here would break
    // them without buying much on a same-origin, auth-gated UI.
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');           // no clickjacking the root terminal
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
        next();
    });

    const isAuthenticated = (req: Request, res: Response, next: NextFunction) => {
        if (req.session.user) {
            next();
        } else {
            if (req.headers.accept?.includes('application/json')) {
                 res.status(401).json({ error: 'Unauthorized' });
            } else {
                 res.status(401).send('Unauthorized. Please login via the admin interface.');
            }
        }
    };


    // Public (no auth): lets the login page identify which gateway this is, so an
    // admin with several identical IP-only tabs open doesn't type creds into the
    // wrong one. Exposes only the gateway's friendly name + accent color, both of
    // which are non-secret (the name already appears in every client's config URL).
    app.get('/admin/info', (req, res) => {
        res.json({ name: GATEWAY_CLIENT_NAME, color: GATEWAY_UI_COLOR });
    });

    // Per-gateway favicon (public): a rounded tile in the gateway's accent color
    // stamped with its initial, so browser tabs are color/letter-coded too.
    app.get('/admin/favicon.svg', (req, res) => {
        const color = GATEWAY_UI_COLOR || '#4f46e5';
        const initial = (GATEWAY_CLIENT_NAME.trim().charAt(0) || '?').toUpperCase()
            .replace(/[<>&"']/g, '?'); // never break the SVG
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
            `<rect width="64" height="64" rx="14" fill="${color}"/>` +
            `<text x="32" y="34" font-family="Segoe UI,Helvetica,Arial,sans-serif" font-size="38" ` +
            `font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${initial}</text>` +
            `</svg>`;
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(svg);
    });

    // Browsable catalog of known MCP servers (from config/catalog.json if present,
    // otherwise the built-in starter list). Used by the admin UI's "Browse Catalog".
    // Curated (installable allowlist) + external (browse-only, live npm search).
    app.get('/admin/catalog', isAuthenticated, async (req, res) => {
        try {
            if (req.query.refresh) externalCache = null;
            const [curated, external] = await Promise.all([loadCurated(), fetchExternalCatalog()]);
            // Hide external entries already on the curated allowlist to avoid dupes.
            const curatedKeys = new Set(curated.map((c: any) => (c.package || c.name || '').toLowerCase()));
            const externalFiltered = external.filter((e: any) => !curatedKeys.has((e.package || e.name || '').toLowerCase()));
            res.json({ curated, external: externalFiltered });
        } catch (error: any) {
            logger.error('Error serving catalog:', error);
            res.status(500).json({ error: 'Failed to load catalog.' });
        }
    });

    // Cached connector icon (GitHub owner avatar), served same-origin.
    app.get('/admin/catalog/icon/:owner', isAuthenticated, async (req, res) => {
        try {
            const buf = await getIconBuffer(req.params.owner || '');
            if (!buf) return res.status(404).end();
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.end(buf);
        } catch { res.status(404).end(); }
    });

    // Admin: promote an external entry onto the curated allowlist (makes it installable).
    app.post('/admin/catalog/approve', isAuthenticated, async (req, res) => {
        try {
            const entry = req.body;
            if (!entry || !entry.package) return res.status(400).json({ error: 'package is required.' });
            const { added, catalog } = await addToCurated(entry);
            logger.log(`Admin '${req.session.user?.username}' ${added ? 'added' : 'kept'} '${entry.package}' on the curated catalog.`);
            res.json({ success: true, added, catalog });
        } catch (error: any) {
            logger.error('Error approving catalog entry:', error);
            res.status(500).json({ error: 'Failed to update curated catalog.' });
        }
    });

    // Admin: remove an entry from the curated allowlist.
    app.post('/admin/catalog/remove', isAuthenticated, async (req, res) => {
        try {
            const key = ((req.body && (req.body.package || req.body.name)) || '').toLowerCase();
            if (!key) return res.status(400).json({ error: 'package or name required.' });
            const curated = await loadCurated();
            const next = curated.filter((c: any) => (c.package || c.name || '').toLowerCase() !== key);
            await saveCurated(next);
            logger.log(`Admin '${req.session.user?.username}' removed '${key}' from the curated catalog.`);
            res.json({ success: true, catalog: next });
        } catch (error: any) {
            logger.error('Error removing catalog entry:', error);
            res.status(500).json({ error: 'Failed to update curated catalog.' });
        }
    });

    // Admin: review connector requests filed by end-users.
    app.get('/admin/requests', isAuthenticated, async (req, res) => {
        try {
            res.json({ requests: await loadRequests() });
        } catch (error: any) {
            logger.error('Error listing requests:', error);
            res.status(500).json({ error: 'Failed to list requests.' });
        }
    });

    app.post('/admin/requests/:id/:decision', isAuthenticated, async (req, res) => {
        const { id, decision } = req.params;
        if (decision !== 'approve' && decision !== 'deny') {
            return res.status(400).json({ error: 'decision must be approve or deny.' });
        }
        try {
            const requests = await loadRequests();
            const reqitem = requests.find((r: any) => r.id === id);
            if (!reqitem) return res.status(404).json({ error: 'Request not found.' });
            reqitem.status = decision === 'approve' ? 'approved' : 'denied';
            reqitem.decidedBy = req.session.user?.username || 'admin';
            reqitem.decidedAt = new Date().toISOString();
            let added = false;
            if (decision === 'approve') {
                const r = await addToCurated({
                    name: reqitem.name, package: reqitem.package, description: reqitem.description,
                    needsConfig: reqitem.needsConfig, category: 'Requested'
                });
                added = r.added;
            }
            await saveRequests(requests);
            logger.log(`Admin '${req.session.user?.username}' ${decision}d request ${id} (${reqitem.package}).`);
            res.json({ success: true, added });
        } catch (error: any) {
            logger.error('Error deciding request:', error);
            res.status(500).json({ error: 'Failed to update request.' });
        }
    });

    // --- Login brute-force throttle ---
    // In-memory and per-IP. Deliberately not a dependency: the store dies with the
    // process, which is the same lifetime as the session store above, and these
    // gateways run a single process. Admin credentials are a single shared
    // username/password, so an unthrottled login endpoint is the cheapest path to
    // a root PTY on this container.
    const LOGIN_MAX_ATTEMPTS = Number(process.env.ADMIN_LOGIN_MAX_ATTEMPTS) || 10;
    const LOGIN_WINDOW_MS = (Number(process.env.ADMIN_LOGIN_WINDOW_MINUTES) || 15) * 60 * 1000;
    const loginAttempts = new Map<string, { count: number; first: number }>();

    const loginThrottle = (req: Request, res: Response, next: NextFunction) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const record = loginAttempts.get(ip);

        if (record && now - record.first < LOGIN_WINDOW_MS) {
            if (record.count >= LOGIN_MAX_ATTEMPTS) {
                const retryAfter = Math.ceil((record.first + LOGIN_WINDOW_MS - now) / 1000);
                logger.warn(`Admin login throttled for ${ip} (${record.count} attempts).`);
                res.setHeader('Retry-After', String(retryAfter));
                return res.status(429).json({
                    success: false,
                    error: `Too many failed login attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`
                });
            }
        } else if (record) {
            loginAttempts.delete(ip); // window expired
        }
        next();
    };

    const recordFailedLogin = (req: Request) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const record = loginAttempts.get(ip);
        if (record && now - record.first < LOGIN_WINDOW_MS) record.count += 1;
        else loginAttempts.set(ip, { count: 1, first: now });
    };

    // Constant-time string compare, so a failed login leaks no information about
    // how much of the credential was correct.
    const safeEqual = (a: string, b: string): boolean => {
        const bufA = Buffer.from(String(a ?? ''), 'utf-8');
        const bufB = Buffer.from(String(b ?? ''), 'utf-8');
        if (bufA.length !== bufB.length) {
            // Still burn a comparison so length alone isn't a fast path.
            crypto.timingSafeEqual(bufA, bufA);
            return false;
        }
        return crypto.timingSafeEqual(bufA, bufB);
    };

    app.post('/admin/login', loginThrottle, (req, res) => {
        const { username, password } = req.body || {};
        const ok = safeEqual(username, ADMIN_USERNAME) && safeEqual(password, ADMIN_PASSWORD);

        if (!ok) {
            recordFailedLogin(req);
            logger.warn(`Failed admin login attempt for username: '${username}'`);
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        // Regenerate the session ID on privilege change, so a session fixed by an
        // attacker before login (e.g. a planted connect.sid) does not become an
        // authenticated one.
        req.session.regenerate((err) => {
            if (err) {
                logger.error('Error regenerating session on login:', err);
                return res.status(500).json({ success: false, error: 'Failed to establish session' });
            }
            req.session.user = { username: username };
            const ip = req.ip || req.socket.remoteAddress || 'unknown';
            loginAttempts.delete(ip);
            logger.log(`Admin user '${username}' logged in.`);
            res.json({ success: true });
        });
    });

    app.post('/admin/logout', (req, res) => {
        const username = req.session.user?.username;
        req.session.destroy((err) => {
            if (err) {
                logger.error("Error destroying session:", err);
                return res.status(500).json({ success: false, error: 'Failed to logout' });
            }
            logger.log(`Admin user '${username}' logged out.`);
            res.clearCookie('connect.sid');
            res.json({ success: true });
        });
    });

    app.get('/admin/config', isAuthenticated, async (req, res) => {
        try {
            logger.log("Admin request: GET /admin/config");
            const configData = await readFile(CONFIG_PATH, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.send(configData);
        } catch (error: any) {
            logger.error(`Error reading config file at ${CONFIG_PATH}:`, error);
            if (error.code === 'ENOENT') {
                 res.status(404).json({ error: 'Configuration file not found.' });
            } else {
                 res.status(500).json({ error: 'Failed to read configuration file.' });
            }
        }
    });

    app.post('/admin/config', isAuthenticated, async (req, res) => {
        try {
            logger.log("Admin request: POST /admin/config");
            const newConfigData = req.body;

            if (typeof newConfigData !== 'object' || newConfigData === null) {
                return res.status(400).json({ error: 'Invalid configuration format: Expected a JSON object.' });
            }

            const configString = JSON.stringify(newConfigData, null, 2);
            await writeFile(CONFIG_PATH, configString, 'utf-8');
            logger.log(`Configuration file updated successfully by admin '${req.session.user?.username}'.`);
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error writing config file at ${CONFIG_PATH}:`, error);
            res.status(500).json({ error: 'Failed to write configuration file.' });
        }
    });


    // Updated to use getCurrentProxyState
    app.get('/admin/tools/list', isAuthenticated, async (req, res) => {
        logger.log("Admin request: GET /admin/tools/list");
        try {
            // Get the current tool state from the proxy module
            const { tools } = getCurrentProxyState();
            // The tools returned are already simplified for the UI
            logger.log(`Admin tools/list: Returning ${tools.length} discovered tools from proxy state.`);
            res.json({ tools }); // Return the simplified list directly
        } catch (error: any) {
            logger.error(`Admin tools/list: Error getting proxy state:`, error?.message || error);
            res.status(500).json({ error: 'Failed to retrieve tool list from proxy state.' });
        }
    });

    app.get('/admin/tools/config', isAuthenticated, async (req, res) => {
        try {
            logger.log("Admin request: GET /admin/tools/config");
            const toolConfigData = await readFile(TOOL_CONFIG_PATH, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.send(toolConfigData);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                 logger.log(`Tool config file ${TOOL_CONFIG_PATH} not found, returning empty config.`);
                 res.json({ tools: {} });
            } else {
                 logger.error(`Error reading tool config file at ${TOOL_CONFIG_PATH}:`, error);
                 res.status(500).json({ error: 'Failed to read tool configuration file.' });
            }
        }
    });

    app.post('/admin/tools/config', isAuthenticated, async (req, res) => {
        try {
            logger.log("Admin request: POST /admin/tools/config");
            const newToolConfigData = req.body;

            if (typeof newToolConfigData !== 'object' || newToolConfigData === null || typeof newToolConfigData.tools !== 'object') {
                return res.status(400).json({ error: 'Invalid tool configuration format: Expected { "tools": { ... } }.' });
            }

            const configString = JSON.stringify(newToolConfigData, null, 2);
            await writeFile(TOOL_CONFIG_PATH, configString, 'utf-8');
            logger.log(`Tool configuration file updated successfully by admin '${req.session.user?.username}'.`);
            res.json({ success: true, message: "Configuration saved. Restart proxy server to apply changes." });
        } catch (error) {
            logger.error(`Error writing tool config file at ${TOOL_CONFIG_PATH}:`, error);
            res.status(500).json({ error: 'Failed to write tool configuration file.' });
        }
    });

    // --- Cosmetic admin-UI layout (server/tool ordering + collapsible groups) ---
    // Display-only preference shared by everyone logging into this gateway. Does NOT
    // touch mcp_server.json / tool_config.json or change any MCP behaviour.
    app.get('/admin/ui-layout', isAuthenticated, async (req, res) => {
        try {
            const raw = await readFile(UI_LAYOUT_PATH, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.send(raw);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                res.json({}); // no layout saved yet
            } else {
                logger.error(`Error reading UI layout at ${UI_LAYOUT_PATH}:`, error);
                res.status(500).json({ error: 'Failed to read UI layout.' });
            }
        }
    });

    app.post('/admin/ui-layout', isAuthenticated, async (req, res) => {
        try {
            const layout = req.body;
            if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) {
                return res.status(400).json({ error: 'Invalid layout: expected an object.' });
            }
            await writeFile(UI_LAYOUT_PATH, JSON.stringify(layout, null, 2), 'utf-8');
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error writing UI layout at ${UI_LAYOUT_PATH}:`, error);
            res.status(500).json({ error: 'Failed to write UI layout.' });
        }
    });

    // Renamed endpoint and updated logic for in-process reload
    app.post('/admin/server/reload', isAuthenticated, async (req, res) => {
        logger.log(`Admin request: POST /admin/server/reload by user '${req.session.user?.username}'`);
        try {
            // Load the latest configurations
            const latestServerConfig = await loadConfig();
            const latestToolConfig = await loadToolConfig();

            // Trigger the update process in mcp-proxy
            await updateBackendConnections(latestServerConfig, latestToolConfig);

            logger.log("Configuration reload completed successfully.");
            res.json({ success: true, message: 'Server configuration reloaded successfully.' });

        } catch (error: any) {
            logger.error("Error during configuration reload:", error);
            res.status(500).json({ success: false, error: 'Failed to reload server configuration.', details: error.message });
        }
    });

    // New endpoint to provide environment info like TOOLS_FOLDER to the frontend
    app.get('/admin/environment', isAuthenticated, async (req, res) => {
        try {
            // Load config to get the current separator
            const config = await loadConfig();
            res.json({
                toolsFolder: process.env.TOOLS_FOLDER || "",
                serverToolnameSeparator: config.serverToolnameSeparator, // Expose the separator
                clientName: GATEWAY_CLIENT_NAME, // Default server name for generated client configs
                sshKeyPath: PRIVATE_KEY_PATH // Default --key for new SSH backends
            });
        } catch (error: any) {
            logger.error("Error fetching environment info for admin UI:", error);
            res.status(500).json({ error: "Failed to fetch environment information." });
        }
    });


    // --- User/token management ---
    // Per-user tokens work via either the Bearer-token or ?key= query-param auth
    // path (same value registered in both allowedTokens and allowedKeys), since
    // Windows clients need the query-param form (see docs) while others may use
    // the header form.
    app.get('/admin/users', isAuthenticated, async (req, res) => {
        try {
            const users = await loadUsers();
            res.json({ users });
        } catch (error: any) {
            logger.error('Error listing users:', error);
            res.status(500).json({ error: 'Failed to list users.' });
        }
    });

    app.post('/admin/users', isAuthenticated, async (req, res) => {
        try {
            const { username } = req.body;
            if (typeof username !== 'string' || username.trim().length === 0) {
                return res.status(400).json({ error: 'A non-empty username is required.' });
            }
            const trimmedUsername = username.trim();
            const users = await loadUsers();
            if (users.some(u => u.username === trimmedUsername)) {
                return res.status(409).json({ error: `User '${trimmedUsername}' already exists.` });
            }
            const token = generateToken();
            const newUser: UserRecord = { username: trimmedUsername, token, createdAt: new Date().toISOString() };
            users.push(newUser);
            await saveUsers(users);
            allowedTokens.add(token);
            allowedKeys.add(token);
            logger.log(`Admin '${req.session.user?.username}' created user '${trimmedUsername}'.`);
            res.json({ success: true, user: newUser });
        } catch (error: any) {
            logger.error('Error creating user:', error);
            res.status(500).json({ error: 'Failed to create user.' });
        }
    });

    app.delete('/admin/users/:username', isAuthenticated, async (req, res) => {
        try {
            const { username } = req.params;
            const users = await loadUsers();
            const target = users.find(u => u.username === username);
            if (!target) {
                return res.status(404).json({ error: `User '${username}' not found.` });
            }
            const remaining = users.filter(u => u.username !== username);
            await saveUsers(remaining);
            allowedTokens.delete(target.token);
            allowedKeys.delete(target.token);
            logger.log(`Admin '${req.session.user?.username}' revoked user '${username}'.`);
            res.json({ success: true });
        } catch (error: any) {
            logger.error('Error revoking user:', error);
            res.status(500).json({ error: 'Failed to revoke user.' });
        }
    });

    // --- Per-tool authorization policy (config/tool_policy.json) ---
    // Takes effect on the next tools/list or tools/call; no restart, no reload,
    // same as user add/revoke. See policy.ts for the format.
    app.get('/admin/tool-policy', isAuthenticated, async (req, res) => {
        try {
            const raw = await readPolicyFile();
            res.json({ exists: raw !== null, policy: raw === null ? null : JSON.parse(raw) });
        } catch (error: any) {
            // Unparseable on disk (hand edit): return the text so it can be fixed.
            logger.error('Error reading tool policy:', error?.message || error);
            res.status(500).json({ error: `Failed to read tool policy: ${error?.message || error}` });
        }
    });

    app.post('/admin/tool-policy', isAuthenticated, async (req, res) => {
        try {
            compilePolicy(req.body);
        } catch (error: any) {
            return res.status(400).json({ error: `Invalid tool policy: ${error?.message || error}` });
        }
        try {
            await writePolicyFile(req.body);
        } catch (error: any) {
            logger.error('Error writing tool policy:', error?.message || error);
            return res.status(500).json({ error: 'Failed to write tool policy file.' });
        }
        logger.log(`Admin '${req.session.user?.username}' updated the tool policy (${TOOL_POLICY_PATH}).`);
        res.json({ success: true });
    });

    // --- Download a ready-to-run Windows installer bundle for a user ---
    // Streams a zip = static base payload (portable node + pre-installed mcp-remote
    // + install scripts) plus a generated params.json carrying this user's token and
    // the gateway URL (derived from the Host header, i.e. however the admin reached
    // this UI). The end user double-clicks Install.bat; nothing else is needed.
    app.get('/admin/users/:username/installer', isAuthenticated, async (req, res) => {
        const { username } = req.params;
        try {
            const users = await loadUsers();
            const user = users.find(u => u.username === username);
            if (!user) {
                return res.status(404).json({ error: `User '${username}' not found.` });
            }

            try {
                await access(INSTALLER_BASE_DIR);
                await access(path.join(INSTALLER_BASE_DIR, 'node', 'node.exe'));
                await access(path.join(INSTALLER_BASE_DIR, 'install.ps1'));
            } catch {
                return res.status(503).json({ error: `Installer base not built on this gateway (${INSTALLER_BASE_DIR}). Run installer-base/build-base.sh.` });
            }

            const host = req.headers.host; // e.g. "gateway.example.internal:3663"
            const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
            const serverName = (typeof req.query.name === 'string' && req.query.name.trim()) ? req.query.name.trim() : GATEWAY_CLIENT_NAME;
            const url = `${proto}://${host}/mcp?key=${user.token}`;
            const params = JSON.stringify({ url, serverName, username }, null, 2);

            const safeUser = username.replace(/[^a-zA-Z0-9_.-]/g, '_');
            const safeServer = serverName.replace(/[^a-zA-Z0-9_.-]/g, '_');
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${safeServer}-setup-${safeUser}.zip"`);

            const archive = archiver('zip', { zlib: { level: 9 } });
            archive.on('error', (err: Error) => {
                logger.error('Installer archive error:', err);
                try { res.destroy(); } catch { /* ignore */ }
            });
            archive.pipe(res);
            archive.directory(path.join(INSTALLER_BASE_DIR, 'node'), 'node');
            archive.directory(path.join(INSTALLER_BASE_DIR, 'mcp-remote'), 'mcp-remote');
            archive.file(path.join(INSTALLER_BASE_DIR, 'install.ps1'), { name: 'install.ps1' });
            archive.file(path.join(INSTALLER_BASE_DIR, 'Install.bat'), { name: 'Install.bat' });
            archive.file(path.join(INSTALLER_BASE_DIR, 'README.txt'), { name: 'README.txt' });
            archive.append(params, { name: 'params.json' });
            await archive.finalize();
            logger.log(`Admin '${req.session.user?.username}' downloaded installer for user '${username}'.`);
        } catch (error: any) {
            logger.error(`Error building installer for '${username}':`, error);
            if (!res.headersSent) res.status(500).json({ error: `Failed to build installer: ${error.message}` });
        }
    });


    // --- Mailboxes (imap-mcp accounts) ---
    // Credentials are encrypted at rest (config/mail_accounts.json, AES-256-GCM)
    // and never sent back to the browser; the connector's own plaintext file
    // (/etc/imap-mcp-accounts.json) is regenerated server-side on every change.
    app.get('/admin/mail-accounts', isAuthenticated, async (req, res) => {
        try {
            const accounts = await listMailAccountsSafe();
            res.json({ accounts });
        } catch (error: any) {
            logger.error('Error listing mail accounts:', error);
            res.status(500).json({ error: 'Failed to list mailboxes.' });
        }
    });

    async function refreshMailBackend(): Promise<string | undefined> {
        try {
            const cfg = await loadConfig();
            const mailCfg = cfg.mcpServers['mail'];
            if (!mailCfg) return 'No "mail" entry in mcp_server.json -- add one pointing at /opt/imap-mcp/index.js, or restart the gateway manually.';
            const ok = await refreshBackendConnection('mail', mailCfg);
            if (!ok) return 'The mail connector did not come back up cleanly -- check its credentials and gateway logs.';
            return undefined;
        } catch (error: any) {
            return `Reconnect failed: ${error.message}`;
        }
    }

    app.post('/admin/mail-accounts', isAuthenticated, async (req, res) => {
        const { name, ...fields } = req.body || {};
        if (typeof name !== 'string' || validateAccountName(name)) {
            return res.status(400).json({ error: validateAccountName(name || '') || 'A valid name is required.' });
        }
        try {
            const account = await upsertMailAccount(name, fields);
            logger.log(`Admin '${req.session.user?.username}' saved mail account '${name}'.`);
            const connectionWarning = await refreshMailBackend();
            res.json({ success: true, account, connectionWarning });
        } catch (error: any) {
            // Deliberately not logging req.body anywhere -- it may carry a password.
            logger.error(`Error saving mail account '${name}': ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to save mailbox.' });
        }
    });

    app.delete('/admin/mail-accounts/:name', isAuthenticated, async (req, res) => {
        try {
            const deleted = await deleteMailAccount(req.params.name);
            if (!deleted) return res.status(404).json({ error: `Mailbox '${req.params.name}' not found.` });
            logger.log(`Admin '${req.session.user?.username}' deleted mail account '${req.params.name}'.`);
            const connectionWarning = await refreshMailBackend();
            res.json({ success: true, connectionWarning });
        } catch (error: any) {
            logger.error(`Error deleting mail account '${req.params.name}': ${error.message}`);
            res.status(500).json({ error: 'Failed to delete mailbox.' });
        }
    });

    app.post('/admin/mail-accounts/test', isAuthenticated, async (req, res) => {
        try {
            const result = await testMailAccountConnection(req.body || {});
            res.json(result);
        } catch (error: any) {
            // Deliberately not logging req.body anywhere -- it may carry a password.
            res.status(500).json({ ok: false, error: error.message || 'Test failed.' });
        }
    });

    // --- Deploy this gateway's SSH public key to a new host ---
    app.get('/admin/deploy-key/public-key', isAuthenticated, async (req, res) => {
        try {
            const publicKey = await getGatewayPublicKey();
            res.json({ publicKey });
        } catch (error: any) {
            logger.error('Error reading gateway public key:', error);
            res.status(500).json({ error: `Failed to read gateway public key: ${error.message}` });
        }
    });

    app.post('/admin/deploy-key', isAuthenticated, async (req, res) => {
        const { host, port, username, password } = req.body;
        if (!host || !username || !password) {
            return res.status(400).json({ error: 'host, username, and password are required.' });
        }
        logger.log(`Admin '${req.session.user?.username}' deploying gateway key to ${username}@${host}:${port || 22}.`);
        try {
            const result = await deployKeyToHost({ host, port: Number(port) || 22, username, password });
            res.json({ success: true, message: result.message });
        } catch (error: any) {
            // Deliberately not logging `password` anywhere, including in this error path.
            logger.error(`Failed to deploy key to ${username}@${host}: ${error.message}`);
            res.status(500).json({ error: `Failed to deploy key: ${error.message}` });
        }
    });

    // Modified install endpoint to use spawn and send SSE updates
    app.post('/admin/server/install/:serverKey', isAuthenticated, async (req, res) => {
        const serverKey = req.params.serverKey;
        const adminSessionId = req.session.id; // Get current admin's session ID
        const clientId = req.ip || `admin-${Date.now()}`; // For logging

        // serverKey is joined into an install path below; reject anything that
        // could traverse out of the tools directory before doing any work.
        if (!SERVER_KEY_RE.test(serverKey)) {
            logger.warn(`[${clientId}] Rejected install for malformed server key: '${serverKey}'`);
            return res.status(400).json({ success: false, error: 'Invalid server key.' });
        }

        logger.log(`[${clientId}] Admin request: POST /admin/server/install/${serverKey} for session ${adminSessionId}`);
        logger.warn(`[${clientId}] SECURITY WARNING: Attempting to execute installation commands for server '${serverKey}'.`);

        // Immediately respond to the HTTP request
        res.json({ success: true, message: `Installation process for '${serverKey}' started. Check for live updates.` });

        // Run the installation process asynchronously
        (async () => {
            const adminRes = adminSseConnections.get(adminSessionId); // Get the SSE connection for this admin

            // Helper function to send SSE events to the specific admin UI
            const sendAdminSseEvent = (event: string, data: any) => {
                if (adminRes && !adminRes.writableEnded) { // Check if connection exists and is writable
                    try {
                        // Ensure data is stringified to handle objects and special characters
                        adminRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    } catch (e) {
                        logger.error(`[${clientId}] Failed to send admin SSE event ${event} for session ${adminSessionId}:`, e);
                    }
                } else if (adminSessionId) { // Log warning only if we expected a connection
                     logger.warn(`[${clientId}] No active admin SSE connection found for session ${adminSessionId} to send event ${event}.`);
                }
            };

            try {
                const config = await loadConfig();
                const serverConfig = config.mcpServers[serverKey];

                if (!serverConfig) {
                    logger.error(`Server configuration not found for key: ${serverKey}`);
                    sendAdminSseEvent('install_error', { serverKey, error: `Server configuration not found for key: ${serverKey}` });
                    return;
                }
                if (!isStdioConfig(serverConfig)) {
                    logger.error(`Installation commands only supported for stdio servers.`);
                    sendAdminSseEvent('install_error', { serverKey, error: `Installation commands only supported for stdio servers.` });
                    return;
                }

                const { installDirectory, installCommands } = serverConfig;
                let absoluteInstallDir: string; // This is the directory for the server itself, e.g., /tools/my-server

                if (installDirectory) { // 1. From mcp_server.json
                    absoluteInstallDir = path.resolve(installDirectory); // path.resolve handles both absolute and relative (to cwd)
                    logger.log(`Using 'installDirectory' from config: ${absoluteInstallDir}`);
                    sendAdminSseEvent('install_info', { serverKey, message: `Using 'installDirectory' from config: ${absoluteInstallDir}` });
                } else if (process.env.TOOLS_FOLDER && process.env.TOOLS_FOLDER.trim() !== '') { // 2. From TOOLS_FOLDER env var
                    absoluteInstallDir = path.resolve(process.env.TOOLS_FOLDER.trim(), serverKey);
                    logger.log(`Using 'TOOLS_FOLDER' env var ('${process.env.TOOLS_FOLDER.trim()}'). Target server directory: ${absoluteInstallDir}`);
                    sendAdminSseEvent('install_info', { serverKey, message: `Using 'TOOLS_FOLDER' env var ('${process.env.TOOLS_FOLDER.trim()}'). Target server directory: ${absoluteInstallDir}` });
                } else { // 3. Default to a 'tools' subfolder in the project's current working directory
                    absoluteInstallDir = path.resolve(process.cwd(), 'tools', serverKey);
                    logger.log(`No 'installDirectory' in config or 'TOOLS_FOLDER' env var. Defaulting to project's 'tools' subfolder. Target server directory: ${absoluteInstallDir}`);
                    sendAdminSseEvent('install_info', { serverKey, message: `No 'installDirectory' in config or 'TOOLS_FOLDER' env var. Defaulting to project's 'tools' subfolder. Target server directory: ${absoluteInstallDir}` });
                }
                
                // Commands should be executed in the parent directory of the server's specific folder
                const executionCwd = path.dirname(absoluteInstallDir); 
                logger.log(`[${clientId}] Target server installation directory for ${serverKey}: ${absoluteInstallDir}`);
                logger.log(`[${clientId}] Execution CWD for install commands of ${serverKey}: ${executionCwd}`);
                sendAdminSseEvent('install_info', { serverKey, message: `Install commands will be executed in: ${executionCwd}` });

                // Ensure executionCwd (parent directory for installation) exists
                try {
                    await mkdir(executionCwd, { recursive: true });
                    sendAdminSseEvent('install_info', { serverKey, message: `Ensured execution directory exists: ${executionCwd}` });
                } catch (mkdirError: any) {
                    logger.error(`Failed to create execution directory '${executionCwd}': ${mkdirError.message}`);
                    sendAdminSseEvent('install_error', { serverKey, error: `Failed to create execution directory '${executionCwd}': ${mkdirError.message}` });
                    throw mkdirError;
                }

                // 1. Check if the specific server directory (absoluteInstallDir) already exists
                try {
                    await access(absoluteInstallDir);
                    logger.log(`Target server directory '${absoluteInstallDir}' already exists. Installation skipped.`);
                    sendAdminSseEvent('install_info', { serverKey, message: `Target server directory '${absoluteInstallDir}' already exists. Installation skipped.` });
                    sendAdminSseEvent('install_complete', { serverKey, code: 0, message: "Already installed." });
                    return; // Stop if already installed
                } catch (error: any) {
                    if (error.code !== 'ENOENT') {
                         logger.error(`Error checking target server directory '${absoluteInstallDir}': ${error.message}`);
                         sendAdminSseEvent('install_error', { serverKey, error: `Error checking target server directory '${absoluteInstallDir}': ${error.message}` });
                         throw error; // Rethrow unexpected errors
                    }
                    logger.log(`Target server directory '${absoluteInstallDir}' does not exist. Proceeding with installation commands...`);
                    sendAdminSseEvent('install_info', { serverKey, message: `Target server directory '${absoluteInstallDir}' does not exist. Proceeding with installation commands...` });
                }

                // 2. Execute install commands using spawn for live output
                const commandsToRun = installCommands && Array.isArray(installCommands) ? installCommands : [];
                if (commandsToRun.length > 0) {
                    logger.log(`Executing ${commandsToRun.length} installation command(s) in ${executionCwd}...`);
                    sendAdminSseEvent('install_info', { serverKey, message: `Executing ${commandsToRun.length} installation command(s) in ${executionCwd}...` });
                    for (const command of commandsToRun) {
                        logger.log(`Executing: ${command}`);
                        sendAdminSseEvent('install_info', { serverKey, message: `Executing: ${command}` });

                        const [cmd, ...args] = tokenizeCommand(command);
                        if (!cmd) {
                            const errorMsg = `Command "${command}" could not be parsed.`;
                            sendAdminSseEvent('install_error', { serverKey, error: errorMsg, command });
                            throw new Error(errorMsg);
                        }
                        if (!INSTALL_COMMAND_ALLOWLIST.has(path.basename(cmd).toLowerCase())) {
                            const errorMsg = `Command "${cmd}" is not an allowed install command. Allowed: ${[...INSTALL_COMMAND_ALLOWLIST].sort().join(', ')}.`;
                            sendAdminSseEvent('install_error', { serverKey, error: errorMsg, command });
                            throw new Error(errorMsg);
                        }

                        const child = spawn(cmd, args, {
                            // No shell: the command string comes from admin-editable
                            // config, and with a shell every install entry is an
                            // arbitrary-command primitive reachable by anything that
                            // can forge one admin request. Dropping the shell also
                            // means no &&, |, or > in install commands -- verified
                            // unused: installCommands is empty on both gateways.
                            shell: false,
                            cwd: executionCwd, // Execute in the calculated parent directory
                            stdio: ['ignore', 'pipe', 'pipe']
                        });

                        // Stream stdout
                        child.stdout.on('data', (data) => {
                            const output = data.toString();
                            logger.log(`[${clientId}] Install stdout (${serverKey}): ${output.trim()}`);
                            sendAdminSseEvent('install_stdout', { serverKey, output });
                        });

                        // Stream stderr
                        child.stderr.on('data', (data) => {
                            const output = data.toString();
                            logger.error(`[${clientId}] Install stderr (${serverKey}): ${output.trim()}`);
                            sendAdminSseEvent('install_stderr', { serverKey, output });
                        });

                        // Wait for command completion
                        const exitCode = await new Promise<number | null>((resolve, reject) => {
                            child.on('close', resolve); 
                            child.on('error', (err) => { 
                                 logger.error(`[${clientId}] Failed to start command "${command}":`, err);
                                 reject(err);
                            });
                        });

                        if (exitCode !== 0) {
                            const errorMsg = `Command "${command}" failed with exit code ${exitCode}.`;
                            sendAdminSseEvent('install_error', { serverKey, error: errorMsg, command, exitCode });
                            throw new Error(errorMsg); 
                        }
                        logger.log(`Command "${command}" completed successfully.`);
                        sendAdminSseEvent('install_info', { serverKey, message: `Command "${command}" completed successfully.` });
                    }
                    logger.log(`All installation commands executed successfully.`);
                    sendAdminSseEvent('install_info', { serverKey, message: `All installation commands executed successfully.` });
                } else {
                    logger.log(`No installation commands provided.`);
                    sendAdminSseEvent('install_info', { serverKey, message: `No installation commands provided.` });
                }

                // 3. After commands, ensure the target server directory (absoluteInstallDir) itself exists.
                // This is important if installCommands were supposed to create it (e.g., git clone serverKey).
                try {
                    await access(absoluteInstallDir);
                    logger.log(`Confirmed target server directory exists: ${absoluteInstallDir}`);
                    sendAdminSseEvent('install_info', { serverKey, message: `Confirmed target server directory exists: ${absoluteInstallDir}` });
                } catch (error: any) {
                     if (error.code === 'ENOENT') { // If it still doesn't exist (e.g. no commands, or commands didn't create it)
                        logger.log(`Target server directory ${absoluteInstallDir} not found after commands. If commands were expected to create it, check them. Creating directory now.`);
                        sendAdminSseEvent('install_info', { serverKey, message: `Target server directory ${absoluteInstallDir} not found after commands. If commands were expected to create it, check them. Creating directory now.` });
                        await mkdir(absoluteInstallDir, { recursive: true }); // Create it as a fallback.
                        logger.log(`Successfully created target server directory ${absoluteInstallDir}.`);
                        sendAdminSseEvent('install_info', { serverKey, message: `Successfully created target server directory ${absoluteInstallDir}.` });
                     } else { // Other access error
                        logger.error(`Error after commands, verifying/creating directory '${absoluteInstallDir}': ${error.message}`);
                        sendAdminSseEvent('install_error', { serverKey, error: `Error after commands, verifying/creating directory '${absoluteInstallDir}': ${error.message}` });
                        throw error;
                     }
                }

                // 4. Send final success event
                sendAdminSseEvent('install_complete', { serverKey, code: 0, message: "Installation process completed successfully." });

            } catch (error: any) {
                logger.error(`[${clientId}] Error during server installation process for '${serverKey}':`, error);
                if (!error.message?.includes('failed with exit code') && 
                    !error.message?.includes('Failed to create execution directory') &&
                    !error.message?.includes('Failed to create installation directory') &&
                    !error.message?.includes('Error checking target server directory') &&
                    !error.message?.includes('Error after commands, verifying/creating directory')) {
                     sendAdminSseEvent('install_error', { serverKey, error: `Installation failed: ${error.message}` });
                }
            }
        })(); // Immediately invoke the async function
    });

    // Add Admin SSE endpoint only if Admin UI is enabled
    app.get('/admin/sse/updates', isAuthenticated, (req, res) => {
        const sessionId = req.session.id; // Get Express session ID
        if (!sessionId) {
            res.status(400).send("Session not found");
            return;
        }

        logger.log(`[Admin SSE] Connection received for session: ${sessionId}`);

        // Set SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        });

        // Send connected event
        res.write(`event: connected\ndata: ${JSON.stringify({ message: "Admin SSE connected" })}\n\n`);

        // Store connection
        adminSseConnections.set(sessionId, res);
        logger.log(`[Admin SSE] Connection stored for session ${sessionId}. Total admin connections: ${adminSseConnections.size}`);

        // Remove connection on close
        req.on('close', () => {
            adminSseConnections.delete(sessionId);
            logger.log(`[Admin SSE] Connection closed for session ${sessionId}. Total admin connections: ${adminSseConnections.size}`);
        });
    });

    // Mount the terminal router under /admin/terminal, protected by authentication
    app.use('/admin/terminal', isAuthenticated, terminalRouter);


    // Static file serving for admin UI should also be inside the if block
    logger.log(`Serving static admin files from: ${publicPath}`);
    app.use('/admin', express.static(publicPath));

    app.get('/admin', (req, res) => {
        res.redirect('/admin/index.html');
    });
    app.get('/admin/', (req, res) => {
        res.redirect('/admin/index.html');
    });

} else { // Correctly placed else block for when Admin UI is disabled
     console.log("Admin UI is DISABLED. Set ENABLE_ADMIN_UI=true to enable.");
} // End of the main if (enableAdminUI) block


app.get("/sse", async (req, res) => {
  const clientId = req.ip || `client-${Date.now()}`;
  logger.log(`[${clientId}] SSE connection received`);

  if (authEnabled) {
    let authenticated = false;

    // 1. Check for Bearer Token in Authorization header
    const authHeader = req.headers['authorization'] as string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring('Bearer '.length).trim();
      if (allowedTokens.has(token)) {
        logger.log(`[${clientId}] Authorized SSE connection using Bearer Token.`);
        authenticated = true;
      } else {
        logger.warn(`[${clientId}] Unauthorized SSE connection attempt. Invalid Bearer Token.`);
      }
    }

    // 2. If not authenticated by Bearer Token, check for API Key
    if (!authenticated && allowedKeys.size > 0) {
      const headerKey = req.headers['x-api-key'] as string | undefined;
      const queryKey = req.query.key as string | undefined;
      const providedKey = headerKey || queryKey;

      if (providedKey && allowedKeys.has(providedKey)) {
        logger.log(`[${clientId}] Authorized SSE connection using ${headerKey ? 'header' : 'query'} API Key.`);
        authenticated = true;
      } else if (providedKey) {
         logger.warn(`[${clientId}] Unauthorized SSE connection attempt. Invalid API Key.`);
      }
    }

    // If authentication is enabled but no valid credentials were provided
    if (!authenticated) {
      logger.warn(`[${clientId}] Unauthorized SSE connection attempt. No valid credentials provided.`);
      res.status(401).send('Unauthorized');
      return;
    }
  }


  // Resolved once per connection, after the auth check above has passed.
  const reqIdentity = await identityForRequest(req);
  if (rejectIfHttpRateLimited(req, res, reqIdentity)) return;

  let clientTransport: SSEServerTransport | null = null;
  const sessionIdFromClientQuery = req.query.session_id as string | undefined;
  let actualTransportSessionId: string | undefined; // The ID generated and used by the SSEServerTransport instance

  try {
    // If client provides a session_id in query, and it exists on the server,
    // it implies an attempt to reconnect or a stale client. Clean up the old one.
    if (sessionIdFromClientQuery && sseTransports.has(sessionIdFromClientQuery)) {
      logger.log(`[${clientId}] Client provided existing session ID: ${sessionIdFromClientQuery}. Closing and removing old transport.`);
      const existingTransport = sseTransports.get(sessionIdFromClientQuery)!;
      sseTransports.delete(sessionIdFromClientQuery); // Remove old one from map
      if (typeof existingTransport.close === 'function') {
        existingTransport.close().catch(err =>
          logger.warn(`[${clientId}] Non-critical error closing existing transport for session ${sessionIdFromClientQuery}:`, err)
        );
      }
      logger.log(`[${clientId}] Old transport for session ${sessionIdFromClientQuery} removed. Active sessions: ${sseTransports.size}`);
    } else if (sessionIdFromClientQuery) {
      logger.log(`[${clientId}] Client provided session ID ${sessionIdFromClientQuery}, but no active session found for it. A new session will be created.`);
    }

    // Always create a new SSEServerTransport.
    // It will generate its own internal sessionId, which will be sent to the client via the 'endpoint' event.
    // The client is expected to use this server-provided sessionId for subsequent POST /message requests.
    logger.log(`[${clientId}] Creating new SSEServerTransport...`);
    clientTransport = new SSEServerTransport("/message", res);
    actualTransportSessionId = clientTransport.sessionId; // Get the ID generated by the transport itself

    if (!actualTransportSessionId) {
      throw new Error("Failed to obtain session ID from new SSE transport instance.");
    }
    
    sseTransports.set(actualTransportSessionId, clientTransport); // Store the new transport with its own generated ID
    logger.log(`[${clientId}] New SSE transport created. Actual Session ID for this connection: ${actualTransportSessionId}. Client initially provided: ${sessionIdFromClientQuery || 'none'}. Active sessions: ${sseTransports.size}`);
    
    const currentTransport = clientTransport; // To use in closures for onclose/onerror
    const currentSessionId = actualTransportSessionId; // To use in closures

    // Bind the caller to this session, so request handlers can attribute calls
    // to it via extra.sessionId.
    setSessionIdentity(currentSessionId, reqIdentity);

    currentTransport.onerror = (err: any) => {
      logger.error(`[${clientId}] SSE transport error for session ${currentSessionId}: ${err?.stack || err?.message || err}`);
      sseTransports.delete(currentSessionId);
      disposeSession(currentSessionId, 'transport error');
      logger.log(`[${clientId}] Session ${currentSessionId} removed due to error. Active sessions: ${activeSessions.size}`);
    };

    currentTransport.onclose = () => {
      logger.log(`[${clientId}] SSE client disconnected for session ${currentSessionId}.`);
      sseTransports.delete(currentSessionId);
      disposeSession(currentSessionId, 'transport close');
      logger.log(`[${clientId}] Session ${currentSessionId} removed on close. Active sessions: ${activeSessions.size}`);
    };

    logger.log(`[${clientId}] Creating per-session server instance for session ${currentSessionId}...`);
    const sessionServer = createServerInstance();
    await sessionServer.connect(currentTransport);
    activeSessions.set(currentSessionId, { server: sessionServer, lastActivity: Date.now() });
    logger.log(`[${clientId}] SSE client connected successfully for session ${currentSessionId}. Active sessions: ${activeSessions.size}`);

  } catch (error: any) {
    const logSessionIdOnError = actualTransportSessionId || sessionIdFromClientQuery || "unknown_during_error_handling";
    logger.error(`[${clientId}] Failed during SSE setup or connection for session attempt related to ${logSessionIdOnError}:`, error);
    
    // If a transport was created and added to the map, ensure it's cleaned up on error.
    if (actualTransportSessionId && sseTransports.has(actualTransportSessionId)) {
       sseTransports.delete(actualTransportSessionId);
       logger.log(`[${clientId}] Transport for session ${actualTransportSessionId} removed due to setup/connection error. Active sessions: ${sseTransports.size}`);
    }
    // Ensure clientTransport (if partially created) is closed on error.
    if (clientTransport && typeof clientTransport.close === 'function') {
      clientTransport.close().catch((e: any) => logger.error(`[${clientId}] Error closing transport for session ${logSessionIdOnError} after connection failure:`, e));
    }
    if (!res.headersSent) {
      res.status(500).send('Failed to establish SSE connection');
    }
  }
});

// Removed GET /message?action=new_session endpoint as it's deemed unnecessary.
// The client should rely on the sessionId provided by the 'endpoint' event from the /sse connection.

app.all("/mcp", async (req, res) => { // Changed to app.all to handle GET for SSE and POST for messages
  const clientId = req.ip || `client-http-${Date.now()}`;
  logger.log(`[${clientId}] Received ${req.method} request on /mcp`);

  // Authentication check (similar to /sse)
  if (authEnabled) {
    let authenticated = false;
    const authHeader = req.headers['authorization'] as string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring('Bearer '.length).trim();
      if (allowedTokens.has(token)) {
        logger.log(`[${clientId}] Authorized /mcp connection using Bearer Token.`);
        authenticated = true;
      } else {
        logger.warn(`[${clientId}] Unauthorized /mcp (Bearer) for ${req.method}. Invalid Token.`);
      }
    }
    if (!authenticated && allowedKeys.size > 0) {
      const headerKey = req.headers['x-api-key'] as string | undefined;
      const queryKey = req.query.key as string | undefined;
      const providedKey = headerKey || queryKey;
      if (providedKey && allowedKeys.has(providedKey)) {
        logger.log(`[${clientId}] Authorized /mcp connection using ${headerKey ? 'header' : 'query'} API Key.`);
        authenticated = true;
      } else if (providedKey) {
         logger.warn(`[${clientId}] Unauthorized /mcp (API Key) for ${req.method}. Invalid Key.`);
      }
    }
    if (!authenticated) {
      logger.warn(`[${clientId}] Unauthorized /mcp for ${req.method}. No valid credentials.`);
      res.status(401).send('Unauthorized');
      return;
    }
  }

  // Resolved once per request, after the auth check above has passed. Re-bound
  // below on every request, not just at session creation, so the attribution
  // always reflects the credential that authenticated *this* request.
  const reqIdentity = await identityForRequest(req);
  if (rejectIfHttpRateLimited(req, res, reqIdentity, req.headers['mcp-session-id'] as string | undefined)) return;

  let httpTransport: StreamableHTTPServerTransport | undefined;
  const clientProvidedSessionId = req.headers['mcp-session-id'] as string | undefined;
  let transportSessionIdToUse: string | undefined = clientProvidedSessionId;

  if (clientProvidedSessionId) {
    httpTransport = streamableHttpTransports.get(clientProvidedSessionId);
    if (!httpTransport) {
      logger.warn(`[${clientId}] /mcp: Client provided Mcp-Session-Id '${clientProvidedSessionId}', but no active transport found. Responding 404.`);
      if (!res.headersSent) {
        res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: `Session not found for Mcp-Session-Id: ${clientProvidedSessionId}` },
            id: (req.body as any)?.id ?? null
        });
      }
      return;
    }
    logger.log(`[${clientId}] /mcp: Using existing transport for Mcp-Session-Id: ${clientProvidedSessionId}`);
    setSessionIdentity(clientProvidedSessionId, reqIdentity);
    touchSession(clientProvidedSessionId); // keep the idle sweep from reaping an active session
  } else {
    // No Mcp-Session-Id from client, or it's an InitializeRequest that might not have one yet.
    // Create a new transport. The transport itself will generate a session ID.
    logger.log(`[${clientId}] /mcp: No Mcp-Session-Id from client, or new session. Creating new StreamableHTTPServerTransport.`);
    const tempGeneratedIdForEarlyMap = `pending-${crypto.randomBytes(8).toString('hex')}`;
    let capturedHttpTransportInstance: StreamableHTTPServerTransport | null = null; // To ensure closure captures the correct instance

    const newTransportOptions: StreamableHTTPServerTransportOptions = {
        sessionIdGenerator: () => crypto.randomUUID(), // Use crypto.randomUUID for session ID generation
        enableJsonResponse: false,
        onsessioninitialized: (sdkGeneratedSessionId: string) => {
            logger.log(`[${clientId}] /mcp: SDK 'onsessioninitialized' called. SDK Session ID: ${sdkGeneratedSessionId}`);
            if (capturedHttpTransportInstance) {
                // The SDK has now initialized the session and `capturedHttpTransportInstance.sessionId` should be set.
                // Verify it matches sdkGeneratedSessionId for sanity.
                if (capturedHttpTransportInstance.sessionId !== sdkGeneratedSessionId) {
                    logger.warn(`[${clientId}] /mcp: Discrepancy! sdkGeneratedSessionId (${sdkGeneratedSessionId}) vs transport.sessionId (${capturedHttpTransportInstance.sessionId}). Using sdkGeneratedSessionId.`);
                }
                const finalSessionId = sdkGeneratedSessionId; // Use the ID from the callback
                // Bound against the FINAL id only. Nothing is ever registered
                // against the temp id, so the remap below cannot orphan an
                // identity entry.
                setSessionIdentity(finalSessionId, reqIdentity);

                // Keep the per-session server registry in step with the transport map.
                // The instance was registered under the temp ID at connect time,
                // before the SDK had issued the real one.
                const managedSession = activeSessions.get(tempGeneratedIdForEarlyMap);
                if (managedSession && finalSessionId !== tempGeneratedIdForEarlyMap) {
                    activeSessions.delete(tempGeneratedIdForEarlyMap);
                    activeSessions.set(finalSessionId, managedSession);
                    logger.log(`[${clientId}] /mcp: Session server remapped from temp '${tempGeneratedIdForEarlyMap}' to final '${finalSessionId}'.`);
                }

                if (streamableHttpTransports.has(tempGeneratedIdForEarlyMap)) {
                    const transportInstanceFromMap = streamableHttpTransports.get(tempGeneratedIdForEarlyMap);
                    if (transportInstanceFromMap === capturedHttpTransportInstance) {
                        streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
                        streamableHttpTransports.set(finalSessionId, capturedHttpTransportInstance);
                        if (transportSessionIdToUse === tempGeneratedIdForEarlyMap) {
                            transportSessionIdToUse = finalSessionId;
                        }
                        logger.log(`[${clientId}] /mcp: Transport map updated. Temp ID '${tempGeneratedIdForEarlyMap}' replaced with final '${finalSessionId}'. Active: ${streamableHttpTransports.size}`);
                    } else {
                        logger.error(`[${clientId}] /mcp: Mismatch during onsessioninitialized! Temp ID ${tempGeneratedIdForEarlyMap} found but instance differs.`);
                        if (!streamableHttpTransports.has(finalSessionId) || streamableHttpTransports.get(finalSessionId) !== capturedHttpTransportInstance) {
                           streamableHttpTransports.set(finalSessionId, capturedHttpTransportInstance);
                           logger.warn(`[${clientId}] /mcp: Force-mapped transport with final ID '${finalSessionId}' due to instance mismatch.`);
                        }
                    }
                } else {
                    if (!streamableHttpTransports.has(finalSessionId) || streamableHttpTransports.get(finalSessionId) !== capturedHttpTransportInstance) {
                        streamableHttpTransports.set(finalSessionId, capturedHttpTransportInstance);
                        if (transportSessionIdToUse === tempGeneratedIdForEarlyMap) {
                           transportSessionIdToUse = finalSessionId;
                        }
                        logger.log(`[${clientId}] /mcp: Transport (re)added to map with final ID '${finalSessionId}' (temp not found or instance check). Active: ${streamableHttpTransports.size}`);
                    }
                }
            } else {
                 logger.error(`[${clientId}] /mcp: onsessioninitialized called but capturedHttpTransportInstance is null. SDK SessionId: ${sdkGeneratedSessionId}`);
            }
        },
    };

    httpTransport = new StreamableHTTPServerTransport(newTransportOptions);
    capturedHttpTransportInstance = httpTransport; // Capture for the onsessioninitialized closure
    
    // Store with a temporary ID. This will be updated by onsessioninitialized when the SDK provides the actual session ID.
    transportSessionIdToUse = tempGeneratedIdForEarlyMap;
    streamableHttpTransports.set(tempGeneratedIdForEarlyMap, httpTransport);
    logger.log(`[${clientId}] /mcp: New transport created. Stored with temp ID: ${tempGeneratedIdForEarlyMap}. Active transports: ${streamableHttpTransports.size}`);

    const currentTransportForHandlers = httpTransport; // Use this specific instance in handlers

    currentTransportForHandlers.onerror = (error: Error) => {
      // Use currentTransportForHandlers.sessionId if available, otherwise fallback to transportSessionIdToUse (which might be temp or final)
      const idToClean = currentTransportForHandlers.sessionId || transportSessionIdToUse;
      logger.error(`[${clientId}] /mcp: StreamableHTTPServerTransport error for session related to ${idToClean}:`, error);
      
      if (streamableHttpTransports.get(tempGeneratedIdForEarlyMap) === currentTransportForHandlers) {
        streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
      }
      if (currentTransportForHandlers.sessionId && streamableHttpTransports.get(currentTransportForHandlers.sessionId) === currentTransportForHandlers) {
        streamableHttpTransports.delete(currentTransportForHandlers.sessionId);
      }
      disposeSession(tempGeneratedIdForEarlyMap, 'transport error');
      disposeSession(currentTransportForHandlers.sessionId, 'transport error');
      logger.log(`[${clientId}] /mcp: Session ${idToClean} removed due to error. Active transports: ${streamableHttpTransports.size}, sessions: ${activeSessions.size}`);
    };

    currentTransportForHandlers.onclose = () => {
      const idToClean = currentTransportForHandlers.sessionId || transportSessionIdToUse;
      logger.log(`[${clientId}] /mcp: StreamableHTTPServerTransport closed for session related to ${idToClean}.`);
      if (streamableHttpTransports.get(tempGeneratedIdForEarlyMap) === currentTransportForHandlers) {
        streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
      }
      if (currentTransportForHandlers.sessionId && streamableHttpTransports.get(currentTransportForHandlers.sessionId) === currentTransportForHandlers) {
        streamableHttpTransports.delete(currentTransportForHandlers.sessionId);
      }
      disposeSession(tempGeneratedIdForEarlyMap, 'transport close');
      disposeSession(currentTransportForHandlers.sessionId, 'transport close');
      logger.log(`[${clientId}] /mcp: Session ${idToClean} removed on close. Active transports: ${streamableHttpTransports.size}, sessions: ${activeSessions.size}`);
    };

    try {
      // Registered under the temp ID; onsessioninitialized remaps it to the real one.
      const sessionServer = createServerInstance();
      await sessionServer.connect(currentTransportForHandlers);
      activeSessions.set(tempGeneratedIdForEarlyMap, { server: sessionServer, lastActivity: Date.now() });
      logger.log(`[${clientId}] /mcp: New transport (temp ID: ${transportSessionIdToUse}, awaiting final SDK sessionId) connected. Active sessions: ${activeSessions.size}`);
    } catch (connectError: any) {
      logger.error(`[${clientId}] /mcp: Failed to connect new transport to server:`, connectError);
      streamableHttpTransports.delete(tempGeneratedIdForEarlyMap); // Clean up temp entry
      if (!res.headersSent) {
        res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: `Failed to connect new MCP transport: ${connectError.message}` },
            id: (req.body as any)?.id ?? null
        });
      }
      return;
    }
  }

  if (!httpTransport) {
    // This case should ideally be caught earlier if clientProvidedSessionId was present but not found.
    // If it's a new session and httpTransport somehow didn't get created.
    logger.error(`[${clientId}] /mcp: Transport is unexpectedly undefined before handling request.`);
    if (!res.headersSent) {
        res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32002, message: "MCP transport not available for session." },
            id: (req.body as any)?.id ?? null
        });
    }
    return;
  }

  logger.log(`[${clientId}] /mcp: About to call transport.handleRequest for session ${transportSessionIdToUse || httpTransport.sessionId} - Method: ${req.method}`);
  try {
    // The SDK's StreamableHTTPServerTransport.handleRequest should:
    // - For new sessions (e.g., on InitializeRequest), establish the session,
    //   generate/obtain a session ID, and ensure Mcp-Session-Id header is in the response.
    // - For existing sessions, use the provided Mcp-Session-Id.
    // - Handle both POST (for client messages) and GET (for server-initiated SSE streams).
    await httpTransport.handleRequest(req, res, req.body);
    logger.log(`[${clientId}] /mcp: transport.handleRequest completed for session ${transportSessionIdToUse || httpTransport.sessionId}. Response stream managed by transport.`);
  } catch (error: any) {
    const idToLog = transportSessionIdToUse || httpTransport.sessionId;
    logger.error(`[${clientId}] /mcp: Error during transport.handleRequest for session ${idToLog}:`, error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal server error during MCP request handling: ${error.message || error}` },
        id: (req.body as any)?.id ?? null
      }) + '\n');
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  logger.log(`Received POST /message for Session ID: ${sessionId}`);

  if (!sessionId) {
    logger.error("POST /message error: Missing sessionId query parameter.");
    return res.status(400).send({ error: "Missing sessionId query parameter" });
  }

  const transport = sseTransports.get(sessionId);

  if (!transport) {
    logger.error(`POST /message error: No active transport found for Session ID: ${sessionId}`);
    return res.status(404).send({ error: `No active session found for ID ${sessionId}` });
  }

  if (rejectIfHttpRateLimited(req, res, getSessionIdentity(sessionId) || UNKNOWN_IDENTITY, sessionId)) return;

  logger.log(`Found transport for session ${sessionId}. Handling POST message...`);
  try {
    await transport.handlePostMessage(req, res, req.body);
    logger.log(`Successfully handled POST for session ${sessionId}`);
  } catch (error: any) {
    logger.error(`Error in transport.handlePostMessage for session ${sessionId}:`, error);
    if (!res.headersSent) {
      res.status(500).send({ error: "Failed to process message via transport" });
    }
  }
});


const PORT = process.env.PORT || 3663;

expressServer.listen(PORT, () => {
  const baseUrl = `http://localhost:${PORT}`;
  logger.log(`Patchbay Gateway is running.`);
  logger.log(`SSE endpoint: ${baseUrl}/sse`);
  logger.log(`Streamable HTTP (MCP) endpoint: ${baseUrl}/mcp`);

  if (authEnabled && allowedKeys.size > 0) {
    const firstKey = allowedKeys.values().next().value;
    logger.log(`Example authenticated SSE endpoint: ${baseUrl}/sse?key=${firstKey}`);
    logger.log(`Example authenticated MCP endpoint: ${baseUrl}/mcp?key=${firstKey} (or use X-Api-Key header)`);
  }

  if (enableAdminUI) {
      logger.log(`Admin UI available at ${baseUrl}/admin`);
  }
});

const shutdown = async (signal: string) => {
  logger.log(`\nReceived ${signal}. Shutting down gracefully...`);
  // Coalesced rate-limit counts live in memory; write them out now rather
  // than lose the tail of a throttled burst on restart. The writes are async,
  // so wait for them -- process.exit() below would otherwise drop them.
  flushRateLimitAudit(Number.POSITIVE_INFINITY);
  await auditDrained();
  try {
    logger.log(`Closing ${activeSessions.size} active session server(s)...`);
    await Promise.all([...activeSessions.entries()].map(([sessionId, session]) =>
        session.server.close().catch((e: any) =>
            logger.warn(`Error closing session ${sessionId}: ${e?.message || e}`))));
    activeSessions.clear();
    logger.log("MCP Server closed.");

    logger.log("Cleaning up backend clients...");
    await cleanup();
    logger.log("Backend clients cleaned up.");

    // Kill any active terminal processes
    logger.log("Killing active terminal sessions...");
    // Add type annotations for the forEach callback parameters
    activeTerminals.forEach((term: ActiveTerminal, id: string) => {
        logger.log(`Killing terminal ${id} (PID: ${term.ptyProcess.pid})`);
        term.ptyProcess.kill();
    });
    activeTerminals.clear();
    TERMINAL_OUTPUT_SSE_CONNECTIONS.clear(); // Also clear SSE connections for terminals
    logger.log("Active terminal sessions killed.");


    logger.log("Closing HTTP server...");
    expressServer.close((err) => {
      if (err) {
        logger.error("Error closing HTTP server:", err);
        process.exit(1);
      } else {
        logger.log("HTTP server closed.");
        process.exit(0);
      }
    });

    setTimeout(() => {
      logger.error("Graceful shutdown timed out. Forcing exit.");
      process.exit(1);
    }, 10000); // Increased timeout slightly

  } catch (error) {
    logger.error("Error during graceful shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
