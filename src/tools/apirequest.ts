import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
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

export const getApiReference = defineTool({
  name: 'get_api_reference',
  description:
    'Discover the full ApparelHub agent API: returns a compact index of every ' +
    'endpoint (path, methods, summary) from the live OpenAPI spec. Use this when ' +
    'no dedicated tool covers what you need, then call it with api_request. ' +
    'Read-only.',
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
