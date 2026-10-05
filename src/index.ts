#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from './logger.js';
import { createServer } from "./mcp-proxy.js";

async function main() {
  const transport = new StdioServerTransport();
  const { cleanup, createServerInstance } = await createServer();
  // stdio is inherently single-session, but it takes an instance from the same
  // factory as the HTTP paths so there is only one way to build a server.
  const server = createServerInstance();

  await server.connect(transport);

  process.on("SIGINT", async () => {
    await cleanup();
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error("Server error:", error.message);
  process.exit(1);
});
