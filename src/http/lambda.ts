import { createHash, timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { loadConfig } from '../config.js';
import { createServer, type ServerDeps } from '../server.js';

// AWS Lambda Function URL entry point (Phase 0.5 prototype — epic #31, ticket #38).
//
// Serves the existing tool surface over the MCP Streamable HTTP transport in STATELESS mode:
// a fresh server + transport pair per request, `enableJsonResponse` so every POST gets a plain
// JSON body (no SSE stream to hold open). Long-running work follows the platform's poll pattern
// (kick off -> `status: processing` + handle -> the client re-polls), so nothing here ever needs
// to hold a connection near the compute ceiling.
//
// Auth is a single static bearer for the prototype: either an `Authorization: Bearer <secret>`
// header or a `/<secret>/...` path prefix (for connector UIs that only accept a URL). This is
// deliberately throwaway — the real OAuth authorization server is Phase 2.

/** Minimal shape of a Lambda Function URL (payload v2) event. Typed locally to avoid a dependency. */
export interface FunctionUrlEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const MIN_SECRET_LENGTH = 32;

/** Constant-time string comparison (hash both sides so lengths never leak). */
function secretsEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function jsonResult(statusCode: number, payload: unknown): FunctionUrlResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

interface AuthOutcome {
  authorized: boolean;
  /** The request path with the secret segment (if used) stripped. */
  path: string;
}

function checkAuth(event: FunctionUrlEvent, path: string, secret: string): AuthOutcome {
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (bearerMatch && secretsEqual(bearerMatch[1], secret)) {
    return { authorized: true, path };
  }
  // Path-embedded secret: /<secret>/mcp — for connector UIs that only take a URL.
  const segments = path.split('/');
  if (segments.length >= 2 && segments[1].length >= MIN_SECRET_LENGTH) {
    if (secretsEqual(segments[1], secret)) {
      const stripped = '/' + segments.slice(2).join('/');
      return { authorized: true, path: stripped === '/' ? '/mcp' : stripped };
    }
  }
  return { authorized: false, path };
}

/**
 * Build the handler with injectable server deps (tests pass a fake `fetchImpl`) and env.
 * The default export below is the production wiring.
 */
export function makeHandler(
  deps: ServerDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  return async function handle(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
    const method = event.requestContext?.http?.method ?? 'GET';
    const rawPath = event.rawPath || '/';

    // Unauthenticated liveness probe. Reveals nothing beyond liveness.
    if (method === 'GET' && rawPath === '/healthz') {
      return jsonResult(200, { ok: true });
    }

    // Fail closed when the bearer is missing or too weak to be a real deployment.
    const secret = (env.MCP_BEARER ?? '').trim();
    if (secret.length < MIN_SECRET_LENGTH) {
      return jsonResult(503, { error: 'server_not_configured' });
    }

    const auth = checkAuth(event, rawPath, secret);
    if (!auth.authorized) {
      return jsonResult(401, { error: 'unauthorized' });
    }

    // Reconstruct a web-standard Request for the transport. The Authorization header is
    // consumed above and deliberately not forwarded.
    const host = event.headers?.host ?? 'lambda';
    const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
    const url = `https://${host}${auth.path}${query}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(event.headers ?? {})) {
      if (v !== undefined && k.toLowerCase() !== 'authorization') headers.set(k, v);
    }
    const bodyText =
      event.body !== undefined && method !== 'GET' && method !== 'HEAD'
        ? event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : event.body
        : undefined;
    const request = new Request(url, { method, headers, body: bodyText });

    // Stateless mode: a fresh server + transport per request (the SDK requires this when
    // sessionIdGenerator is undefined). Construction is cheap — the registry is in-memory.
    const config = loadConfig(env);
    const { server } = createServer(config, deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      return { statusCode: response.status, headers: outHeaders, body: await response.text() };
    } finally {
      await server.close().catch(() => undefined);
    }
  };
}

export const handler = makeHandler();
