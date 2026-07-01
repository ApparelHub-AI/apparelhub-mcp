#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { SERVER_VERSION, TOOL_SURFACE_VERSION } from './version.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, telemetry } = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Best-effort flush of the buffered telemetry signal on shutdown (fire-and-forget).
  process.on('beforeExit', () => {
    void telemetry.flush();
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void telemetry.flush();
      process.exit(0);
    });
  }

  // stdout is the MCP protocol channel — all logging goes to stderr.
  const keyNote = config.apiKey
    ? ''
    : ' WARNING: APPARELHUB_API_KEY not set; tool calls will return auth_required.';
  console.error(
    `apparelhub-mcp ${SERVER_VERSION} ready over stdio (tool surface v${TOOL_SURFACE_VERSION}).${keyNote}`,
  );
}

main().catch((err) => {
  console.error('apparelhub-mcp: fatal error during startup:', err);
  process.exit(1);
});
