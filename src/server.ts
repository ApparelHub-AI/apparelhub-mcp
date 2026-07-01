import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';
import type { Config } from './config.js';
import { ApiClient, type FetchLike } from './http/client.js';
import { ProgressReporter, type SendNotification } from './progress.js';
import { Telemetry, type TelemetryEvent } from './telemetry.js';
import { LocalImaging, type Imaging } from './image/imaging.js';
import { isRecord } from './util/shape.js';
import { ToolRegistry } from './tools/registry.js';
import { allTools } from './tools/index.js';
import { toErrorPayload } from './errors.js';
import type { ToolContext } from './tools/context.js';

export interface CreatedServer {
  server: Server;
  registry: ToolRegistry;
  api: ApiClient;
  telemetry: Telemetry;
}

// A strict per-tool allowlist of SAFE, non-identifying arg keys to emit as coarse telemetry
// features. Never prompts, names, ids, urls, or customer data (spec §9 privacy boundary).
const COARSE_ARG_ALLOWLIST: Record<string, string[]> = {
  generate_image: ['source', 'style', 'size'],
  design_apparel: ['source', 'style', 'needs_transparency'],
  iterate_design: ['source'],
  browse_catalog: ['provider', 'category', 'has_aop'],
  get_garment_details: ['provider'],
  recommend_garment: ['target_audience', 'budget_tier'],
  ship_product: ['generate_mockup'],
  auto_optimize_listings: ['scope', 'dry_run'],
  analyze_what_works: ['scope', 'time_window'],
  recover_from_outage: ['scope', 'dry_run'],
};

function coarseFeatures(tool: string, args: unknown): Record<string, string | number | boolean> {
  const allow = COARSE_ARG_ALLOWLIST[tool];
  if (!allow || !isRecord(args)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const k of allow) {
    const v = args[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
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
  // The ingest endpoint (POST /agents/v1/telemetry) is a pending backend workstream; until it
  // exists, batched sends fail silently (fire-and-forget). Only wired when a key is present.
  const telemetrySender = config.apiKey
    ? async (events: TelemetryEvent[]): Promise<void> => {
        await api.post('telemetry', {
          body: { client: 'apparelhub-mcp', version: SERVER_VERSION, events },
        });
      }
    : undefined;
  const telemetry = new Telemetry(config.telemetryEnabled, telemetrySender);
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
      telemetry.record({
        tool: name,
        outcome: 'ok',
        latency_ms: Date.now() - started,
        coarse_features: coarseFeatures(name, args),
      });
      return { content: [{ type: 'text', text: stringify(result) }] };
    } catch (err) {
      const payload = toErrorPayload(err);
      telemetry.record({
        tool: name,
        outcome: 'error',
        error_code: payload.error.code,
        latency_ms: Date.now() - started,
        coarse_features: coarseFeatures(name, args),
      });
      return { content: [{ type: 'text', text: stringify(payload) }], isError: true };
    }
  });

  return { server, registry, api, telemetry };
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
