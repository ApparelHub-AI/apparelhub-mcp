import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';
import type { Config } from './config.js';
import { ApiClient, type FetchLike } from './http/client.js';
import { ProgressReporter, type SendNotification } from './progress.js';
import { Telemetry } from './telemetry.js';
import { LocalImaging, type Imaging } from './image/imaging.js';
import { ToolRegistry } from './tools/registry.js';
import { allTools } from './tools/index.js';
import { toErrorPayload } from './errors.js';
import type { ToolContext } from './tools/context.js';

export interface CreatedServer {
  server: Server;
  registry: ToolRegistry;
  api: ApiClient;
}

export interface ServerDeps {
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  imaging?: Imaging;
}

export function createServer(config: Config, deps: ServerDeps = {}): CreatedServer {
  const api = new ApiClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    userAgent: config.userAgent,
    fetchImpl: deps.fetchImpl,
    sleepImpl: deps.sleepImpl,
  });
  const telemetry = new Telemetry(config.telemetryEnabled);
  const imaging = deps.imaging ?? new LocalImaging();
  const registry = new ToolRegistry();
  registry.registerAll(allTools());

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.list() }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = request.params.arguments;
    const token = request.params._meta?.progressToken;
    const progress = new ProgressReporter(
      extra.sendNotification as unknown as SendNotification,
      token,
    );
    const ctx: ToolContext = { api, progress, telemetry, config, imaging, signal: extra.signal };

    const started = Date.now();
    try {
      const result = await registry.dispatch(name, args, ctx);
      telemetry.record({ tool: name, outcome: 'ok', latency_ms: Date.now() - started });
      return { content: [{ type: 'text', text: stringify(result) }] };
    } catch (err) {
      const payload = toErrorPayload(err);
      telemetry.record({
        tool: name,
        outcome: 'error',
        error_code: payload.error.code,
        latency_ms: Date.now() - started,
      });
      return { content: [{ type: 'text', text: stringify(payload) }], isError: true };
    }
  });

  return { server, registry, api };
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({
      error: { code: 'serialization_error', message: 'Tool result could not be serialized.' },
    });
  }
}
