import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
import { SERVER_VERSION } from '../version.js';
import { isRecord, str } from '../util/shape.js';

// -----------------------------------------------------------------------------
// Escape hatch (epic #47, B1). Two tools that let the agent self-discover and
// reach ANY /agents/v1 endpoint, so a missing dedicated tool never blocks a
// user. The connector's own API key is the security boundary; these tools do
// not widen it. Prefer a dedicated tool when one exists — the descriptions say
// so, and dedicated tools return clean, annotated projections.
// -----------------------------------------------------------------------------

/** Reject anything that isn't a plain relative path under /agents/v1: no scheme
 *  (host escape), no `..` traversal out of the base, no protocol-relative `//`. */
function safeRelPath(raw: string): string {
  const path = (raw ?? '').trim();
  const rel = path.replace(/^\/+/, ''); // buildUrl also strips leading slashes
  if (!rel) {
    throw new AhError({
      code: 'invalid_path',
      message: 'path is required (a relative path under /agents/v1, e.g. "orders" or "store/<uuid>/collections").',
    });
  }
  if (rel.includes('://') || path.startsWith('//')) {
    throw new AhError({
      code: 'invalid_path',
      message: 'path must be a relative path under /agents/v1, not a full URL.',
    });
  }
  if (rel.split('/').some((seg) => seg === '..')) {
    throw new AhError({
      code: 'invalid_path',
      message: 'path may not contain ".." — it is scoped under /agents/v1.',
    });
  }
  return rel;
}

/**
 * What this server actually serves right now, for a client to compare against
 * what it thinks it has.
 *
 * ⛔ WHY THIS RIDES AN EXISTING TOOL RATHER THAN A NEW ONE.
 * A client whose tool list is stale does not have any tool added after its list
 * was fetched — so a dedicated `check_connector_version` tool would be invisible
 * to exactly the clients that need it. It has to arrive through a tool the agent
 * ALREADY has, and `get_api_reference` is the natural one: it is old, read-only,
 * and already the thing an agent reaches for when a capability seems missing.
 *
 * The mechanism works because a stale client holds old tool DESCRIPTIONS while
 * the server runs current CODE — so this block reaches it in the response even
 * though its schema for this tool predates the block existing.
 *
 * Why the server cannot just tell the client instead: MCP announces a changed
 * tool list with `notifications/tools/list_changed`, which needs an open,
 * stateful session to push over. This server is deliberately stateless
 * streamable-HTTP (that is what lets it run on a Lambda Function URL), so it has
 * no channel to announce on and a client only ever learns by asking again.
 */
async function connectorSelfReport(): Promise<Record<string, unknown>> {
  // Imported lazily: `index.ts` imports THIS module, so a top-level import would
  // be a load-order cycle. By call time the module graph is initialised.
  const { allTools } = await import('./index.js');
  const names = allTools().map((t) => t.name).sort();
  return {
    server_version: SERVER_VERSION,
    tool_count: names.length,
    tool_names: names,
    self_check: (
      'Compare `tool_names` with the tools you can actually call. Anything listed ' +
      'here that you cannot call means YOUR tool list is stale — it was fetched ' +
      'before this server was last updated, and the missing tool does exist.'
    ),
    if_stale: (
      'Tell the user to reconnect the connector (toggle it off and on, or remove ' +
      'and re-add it). A plain "refresh" is not always enough: some clients ' +
      're-read their own cached registry rather than re-requesting the tool list. ' +
      'This server is stateless and never caches — it cannot push a change ' +
      'notification, so a client only learns by asking again. Meanwhile you can ' +
      'reach any missing capability through api_request using the endpoint index ' +
      'below.'
    ),
  };
}

export const getApiReference = defineTool({
  name: 'get_api_reference',
  description:
    'Discover the full ApparelHub agent API: returns a compact index of every ' +
    'endpoint (path, methods, summary) from the live OpenAPI spec. Use this when ' +
    'no dedicated tool covers what you need, then call it with api_request. ' +
    'Read-only.\n\n' +
    'Also returns `connector`, which reports what THIS server actually serves: ' +
    'its version, and the name of every tool. **If a capability seems missing, ' +
    'check that first.** A tool listed in `connector.tool_names` that you cannot ' +
    'call means your own tool list is stale, not that the tool is unbuilt — say ' +
    'so and tell the user to reconnect, rather than reporting the feature as ' +
    'missing.',
  inputSchema: z.object({
    filter: z
      .string()
      .optional()
      .describe('Only return endpoints whose path contains this substring (e.g. "orders", "collections").'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const spec = await ctx.api.get<unknown>('openapi.json', { signal: ctx.signal });
    const paths = isRecord(spec) && isRecord(spec.paths) ? spec.paths : {};
    const filter = (input.filter ?? '').toLowerCase();
    const endpoints: Array<{ path: string; methods: string[]; summary?: string }> = [];
    for (const [p, ops] of Object.entries(paths)) {
      if (filter && !p.toLowerCase().includes(filter)) continue;
      if (!isRecord(ops)) continue;
      const methods = Object.keys(ops)
        .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m.toLowerCase()))
        .map((m) => m.toUpperCase());
      if (methods.length === 0) continue;
      const first = ops[Object.keys(ops)[0]];
      endpoints.push({ path: p, methods, summary: str(first, 'summary', 'description') });
    }
    endpoints.sort((a, b) => a.path.localeCompare(b.path));
    const info = isRecord(spec) && isRecord(spec.info) ? spec.info : {};
    return {
      title: str(info, 'title') ?? 'ApparelHub Agent API',
      version: str(info, 'version'),
      total: endpoints.length,
      endpoints,
      // Deliberately NOT gated behind a `filter` — a stale client asking about
      // one namespace still needs to be able to discover that it is stale.
      connector: await connectorSelfReport(),
      hint: 'Call api_request({ method, path }) to invoke any of these. Paths are relative under /agents/v1.',
    };
  },
});

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const apiRequest = defineTool({
  name: 'api_request',
  description:
    'Escape hatch: make an authenticated request to any ApparelHub agent API ' +
    'endpoint under /agents/v1, as the connected account. PREFER a dedicated ' +
    'tool when one exists (they return clean, guarded results) — use this only ' +
    'for capabilities no tool covers. Call get_api_reference first to find the ' +
    'right path. `path` is relative (e.g. "orders", "store/<uuid>/settings"); ' +
    'no full URLs. Scoped to the account\'s own permissions.',
  inputSchema: z.object({
    method: z.enum(METHODS).describe('HTTP method.'),
    path: z.string().describe('Relative path under /agents/v1, e.g. "orders" or "product/<uuid>/archive". No host, no "..".'),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
      .describe('Query-string parameters.'),
    body: z.record(z.string(), z.unknown()).optional().describe('JSON request body (for POST/PUT/PATCH).'),
    workspace: z.string().optional().describe('Workspace uuid to scope to (agency accounts).'),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const rel = safeRelPath(input.path);
    const data = await ctx.api.request<unknown>(input.method, rel, {
      query: input.query,
      body: input.body,
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { ok: true, method: input.method, path: rel, data };
  },
});

export const apiTools: ToolDef[] = [getApiReference, apiRequest];

// Exposed for unit tests.
export const __test = { safeRelPath };
