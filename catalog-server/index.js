#!/usr/bin/env node
/**
 * connectors — a small meta-MCP server bundled with the gateway. It gives end
 * users (via their Claude client) a way to BROWSE available connectors and
 * REQUEST ones that aren't installed yet. Requests land in a file an admin
 * reviews in the gateway's admin UI. Users can never install directly — only
 * request; an admin approves.
 *
 * Env:
 *   CATALOG_FILE              path to the curated allowlist (config/catalog.json)
 *   REQUESTS_FILE             path to the requests store (config/requests.json)
 *   EXTERNAL_REGISTRY_QUERY   npm search query for the browse-only external list
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const CATALOG_FILE = process.env.CATALOG_FILE || "";
const REQUESTS_FILE = process.env.REQUESTS_FILE || "";
const QUERY = process.env.EXTERNAL_REGISTRY_QUERY || "mcp server";
const SIZE = parseInt(process.env.EXTERNAL_REGISTRY_SIZE || "50", 10);

async function loadCurated() {
  try { const raw = await fs.readFile(CATALOG_FILE, "utf-8"); const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
  catch { return []; }
}
async function fetchExternal() {
  try {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(QUERY)}&size=${SIZE}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    return (d.objects || []).map((o) => {
      const p = o.package || {};
      return { name: (p.name || "").split("/").pop(), package: p.name, description: p.description || "", source: "npm" };
    }).filter((x) => x.package);
  } catch { return []; }
}
async function loadRequests() {
  try { const raw = await fs.readFile(REQUESTS_FILE, "utf-8"); const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
  catch { return []; }
}
async function saveRequests(items) { await fs.writeFile(REQUESTS_FILE, JSON.stringify(items, null, 2), "utf-8"); }

const server = new McpServer({ name: "connectors", version: "1.0.0" });

server.registerTool(
  "list_available_connectors",
  {
    title: "List available connectors",
    description:
      "Browse MCP connectors for this gateway. 'available' = curated and ready for an admin to install; 'external' = published on npm but not yet approved (use request_connector to ask for one).",
    inputSchema: { search: z.string().optional().describe("Filter by name/description substring") },
  },
  async ({ search }) => {
    const [curated, external] = await Promise.all([loadCurated(), fetchExternal()]);
    const curatedKeys = new Set(curated.map((c) => (c.package || c.name || "").toLowerCase()));
    const ext = external.filter((e) => !curatedKeys.has((e.package || e.name || "").toLowerCase()));
    const f = (s) => !search || `${s.name} ${s.package} ${s.description}`.toLowerCase().includes(search.toLowerCase());
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          available: curated.filter(f).map((c) => ({ name: c.name, package: c.package, description: c.description })),
          external: ext.filter(f).slice(0, 40).map((e) => ({ name: e.name, package: e.package, description: e.description })),
          note: "To use an 'external' connector, call request_connector with its package name — an admin reviews and approves it.",
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "request_connector",
  {
    title: "Request a connector",
    description: "Ask an admin to add an MCP connector to this gateway. Use a package name from list_available_connectors.",
    inputSchema: {
      package: z.string().describe("npm package name, e.g. @modelcontextprotocol/server-github"),
      name: z.string().optional().describe("Friendly name"),
      reason: z.string().optional().describe("Why you need it"),
      requester: z.string().optional().describe("Your name, so the admin knows who asked"),
    },
  },
  async ({ package: pkg, name, reason, requester }) => {
    if (!REQUESTS_FILE) return { content: [{ type: "text", text: "Requests aren't configured on this gateway." }], isError: true };
    const requests = await loadRequests();
    const item = {
      id: crypto.randomUUID().slice(0, 8),
      package: pkg,
      name: name || pkg.split("/").pop(),
      description: "",
      reason: reason || "",
      requester: requester || "",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    requests.push(item);
    await saveRequests(requests);
    return { content: [{ type: "text", text: `Request filed (id ${item.id}) for "${pkg}". An admin will review it in the gateway's Requests tab.` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`connectors meta-server: ready (curated=${CATALOG_FILE ? "yes" : "no"}, requests=${REQUESTS_FILE ? "yes" : "no"})`);
