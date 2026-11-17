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
      message:
        'path is required (a relative path under /agents/v1, e.g. "orders" or "store/<uuid>/collections").',
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
 * A client whose tool list is stale does not have any tool added AFTER that list
 * was fetched — so a dedicated `check_connector_version` tool would be invisible
 * to exactly the clients that need it. It has to arrive through a tool the agent
 * ALREADY has, and `get_api_reference` is the natural one: long-standing,
 * read-only, and already what an agent reaches for when a capability seems
 * missing.
 *
 * It works because a stale client holds old tool DESCRIPTIONS while the server
 * runs current CODE, so this block reaches it in the response even though its
 * schema for this tool predates the block existing.
 *
 * Why the server cannot just announce the change instead: MCP signals a changed
 * tool list with `notifications/tools/list_changed`, which needs an open,
 * stateful session to push over. This server is deliberately stateless
 * streamable-HTTP (that is what lets it run on a Lambda Function URL), so it has
 * no channel to announce on and a client only ever learns by asking again.
 *
 * ⚠️ `names` comes from the CONTEXT, injected by the registry. Importing the tool
 * index here instead is a circular import: it survives unit tests and breaks the
 * bundled Lambda build, which is how the first attempt at this failed.
 */
function connectorSelfReport(
  names: string[] | undefined,
  fingerprints?: string[],
): Record<string, unknown> {
  const report: Record<string, unknown> = { server_version: SERVER_VERSION };
  if (!names || names.length === 0) {
    // Reporting `tool_count: 0` would be worse than saying nothing: an agent
    // could read it as "the server serves fewer tools than I have".
    report.tool_names_unavailable =
      'This server could not enumerate its own tools on this call. Compare ' +
      '`server_version` against the version your client connected with instead.';
    return report;
  }
  report.tool_count = names.length;
  report.tool_names = names;
  if (fingerprints && fingerprints.length > 0) {
    report.tool_fingerprints = fingerprints;
  }
  report.self_check =
    'Three ways your tool list can be stale. Names alone only catch the first two.\n' +
    '1. ADDED — listed in `tool_names` but you cannot call it. It exists; your ' +
    'list predates it.\n' +
    '2. REMOVED — you can call it but it is NOT listed here. It is gone.\n' +
    '3. MODIFIED — same name on both sides, but its schema or wording changed ' +
    'under you. Compare `tool_fingerprints`: each entry is `name [#abcdef]`, and ' +
    "the SAME marker is printed at the end of that tool's description in your own " +
    'tool list. Markers differ means your copy of THAT tool is out of date — ' +
    're-read it before calling it, and do NOT repeat its old description back to ' +
    'the user as fact. This is the dangerous one: nothing errors. You simply send ' +
    'arguments its current schema rejects, or state something about the platform ' +
    'that is no longer true.';
  report.if_stale =
    'Tell the user to reconnect the connector (toggle it off and on, or remove ' +
    'and re-add it). A plain "refresh" is not always enough: some clients ' +
    're-read their own cached registry rather than re-requesting the tool list. ' +
    'This server is stateless and never caches — it cannot push a change ' +
    'notification, so a client only learns by asking again. Meanwhile you can ' +
    'reach any missing capability through api_get / api_create / api_update / ' +
    'api_delete using the endpoint index below.';
  return report;
}

export const getApiReference = defineTool({
  name: 'get_api_reference',
  description:
    'Discover the full ApparelHub agent API: returns a compact index of every ' +
    'endpoint (path, methods, summary) from the live OpenAPI spec. Use this when ' +
    'no dedicated tool covers what you need, then call it with api_get (reads) or ' +
    'api_create / api_update / api_delete (changes). ' +
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
      .describe(
        'Only return endpoints whose path contains this substring (e.g. "orders", "collections").',
      ),
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
      connector: connectorSelfReport(ctx.toolNames, ctx.toolFingerprints),
      hint: 'Read with api_get({ path }); change data with api_create (POST), api_update (PATCH/PUT) or api_delete (DELETE). Paths are relative under /agents/v1.',
    };
  },
});

// -----------------------------------------------------------------------------
// The escape hatch, split by what it can do (#217).
//
// It used to be ONE tool, `api_request`, taking any method. A client decides from a
// tool's hints whether a call can run without asking, and one tool that both reads
// and writes can't be hinted honestly: it was either over-cautious on every read or
// under-cautious on every write. Each tool below takes exactly one kind of method and
// says so in its hints, so reads run freely and writes are confirmed.
// -----------------------------------------------------------------------------

/** Where the agent learns what it can call; named in every description (#217). */
const API_DOCS = 'the ApparelHub Agent API (https://apparelhub.ai/developer/api-docs)';

const pathField = z
  .string()
  .describe(
    'Relative path under /agents/v1, e.g. "orders" or "product/<uuid>/archive". No host, no "..".',
  );
const queryField = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe('Query-string parameters.');
const bodyField = z.record(z.string(), z.unknown()).optional().describe('JSON request body.');
const workspaceField = z
  .string()
  .optional()
  .describe('Workspace uuid to scope to (agency accounts).');

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function callApi(
  method: HttpMethod,
  input: {
    path: string;
    query?: Record<string, string | number | boolean>;
    body?: Record<string, unknown>;
    workspace?: string;
  },
  ctx: Parameters<ToolDef['handler']>[1],
) {
  const rel = safeRelPath(input.path);
  const data = await ctx.api.request<unknown>(method, rel, {
    query: input.query,
    body: input.body,
    workspace: input.workspace,
    signal: ctx.signal,
  });
  return { ok: true, method, path: rel, data };
}

const PREFER =
  'PREFER a dedicated tool when one exists (they return clean, guarded results); use this ' +
  'only for capabilities no tool covers. Call get_api_reference first to find the right ' +
  'path. `path` is relative (e.g. "orders", "store/<uuid>/settings"); no full URLs. Scoped ' +
  "to the account's own permissions.";

export const apiGet = defineTool({
  name: 'api_get',
  description:
    `Read from ${API_DOCS} with an authenticated GET, as the connected account. ` +
    `Read-only: it cannot change anything. ${PREFER}`,
  inputSchema: z.object({ path: pathField, query: queryField, workspace: workspaceField }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => callApi('GET', input, ctx),
});

export const apiCreate = defineTool({
  name: 'api_create',
  description:
    `Create something or run an action in ${API_DOCS} with an authenticated POST, as the ` +
    `connected account. Changes data. ${PREFER}`,
  inputSchema: z.object({
    path: pathField,
    query: queryField,
    body: bodyField,
    workspace: workspaceField,
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => callApi('POST', input, ctx),
});

export const apiUpdate = defineTool({
  name: 'api_update',
  description:
    `Update something in ${API_DOCS} with an authenticated PATCH (partial update, the ` +
    `default) or PUT (full replace), as the connected account. Changes data. ${PREFER}`,
  inputSchema: z.object({
    method: z
      .enum(['PATCH', 'PUT'])
      .default('PATCH')
      .describe('PATCH (default) or PUT, as the endpoint requires.'),
    path: pathField,
    query: queryField,
    body: bodyField,
    workspace: workspaceField,
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => callApi(input.method, input, ctx),
});

export const apiDelete = defineTool({
  name: 'api_delete',
  description:
    `Delete something in ${API_DOCS} with an authenticated DELETE, as the connected ` +
    `account. Changes data and may be irreversible: confirm with the user first. ${PREFER}`,
  inputSchema: z.object({
    path: pathField,
    query: queryField,
    body: bodyField,
    workspace: workspaceField,
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => callApi('DELETE', input, ctx),
});

export const apiTools: ToolDef[] = [getApiReference, apiGet, apiCreate, apiUpdate, apiDelete];

// Exposed for unit tests.
export const __test = { safeRelPath };
