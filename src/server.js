/**
 * Wiring: build an MCP server around a TypeSafe client and run it over stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { TypeSafeClient } from "./client.js";
import { createEvaluateHandler, evaluateToolConfig } from "./tool.js";
import { SERVER_INSTRUCTIONS, SERVER_NAME, baseUrl, requireApiKey } from "./config.js";
import { version } from "./version.js";

/**
 * @param {object} [options]
 * @param {import("./client.js").TypeSafeClient} [options.client] Supply to bypass env lookup.
 */
export function createServer({ client } = {}) {
  const api =
    client ?? new TypeSafeClient({ apiKey: requireApiKey(), baseUrl: baseUrl() });

  const server = new McpServer(
    { name: SERVER_NAME, version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool("evaluate", evaluateToolConfig, createEvaluateHandler(api));
  return server;
}

/** Runs until the transport closes or the process is signalled. */
export async function serve() {
  const server = createServer();
  const transport = new StdioServerTransport();

  // stdout is the protocol channel; anything we say goes to stderr.
  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(transport);
}
