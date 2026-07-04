import { createHash, timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { API_BASE_URL, loadConfig } from '../config.js';
import { createServer, type ServerDeps } from '../server.js';

// AWS Lambda Function URL entry point (epic #31).
//
// Serves the existing tool surface over the MCP Streamable HTTP transport in STATELESS mode:
// a fresh server + transport pair per request, `enableJsonResponse` so every POST gets a plain
// JSON body (no SSE stream to hold open). Long-running work follows the platform's poll pattern
// (kick off -> `status: processing` + handle -> the client re-polls), so nothing here ever needs
// to hold a connection near the compute ceiling.
//
// Auth (Phase 2, #41): `Authorization: Bearer <access_token>` issued by the platform's OAuth
// authorization server. Tokens are opaque — this server resolves them to the linked account's
// connector API key via the platform's service-authenticated resolve endpoint and caches the
// result briefly in-container. The Phase 0.5 static bearer (header or /<secret>/ path prefix)
// survives ONLY behind MCP_STATIC_BEARER_ENABLED=true for smoke testing, and dies in Phase 3.

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

/** Redact any secret-length path segment: log only its length + a hash prefix (never the value). */
function redactPath(path: string): string {
  return path
    .split('/')
    .map((seg) =>
      seg.length >= MIN_SECRET_LENGTH
        ? `<seg${seg.length}:${createHash('sha256').update(seg).digest('hex').slice(0, 8)}>`
        : seg,
    )
    .join('/');
}

function jsonResult(
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): FunctionUrlResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

// --- OAuth bearer resolution (#41) ---

interface ResolvedToken {
  apiKey: string;
  userPublicId: string;
  /** Cache eviction time (ms epoch): min(now + TTL, token expiry). */
  cacheUntilMs: number;
}

const RESOLVE_CACHE_TTL_MS = 5 * 60 * 1000;
const RESOLVE_CACHE_MAX = 1000;
// Module scope: survives warm invocations, dies with the container. Keyed by token sha256
// so raw token material never sits in memory longer than the request that carried it.
const resolveCache = new Map<string, ResolvedToken>();

/** Test hook — the cache is module-scope and vitest runs share the module. */
export function _clearResolveCacheForTests(): void {
  resolveCache.clear();
}

function tokenCacheKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function resolveBearer(
  raw: string,
  serviceKey: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; resolved: ResolvedToken } | { ok: false; error: string }> {
  const key = tokenCacheKey(raw);
  const cached = resolveCache.get(key);
  if (cached && cached.cacheUntilMs > Date.now()) {
    return { ok: true, resolved: cached };
  }
  resolveCache.delete(key);

  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE_URL}/service/connector/resolve-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': serviceKey },
      body: JSON.stringify({ token: raw }),
    });
  } catch {
    return { ok: false, error: 'resolve_unavailable' };
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body — fall through to the status check */
  }
  if (response.status !== 200 || typeof payload.api_key !== 'string') {
    const error = typeof payload.error === 'string' ? payload.error : 'unauthorized';
    return { ok: false, error };
  }
  const expiresMs =
    Date.parse(String(payload.expires_at ?? '')) || Date.now() + RESOLVE_CACHE_TTL_MS;
  const resolved: ResolvedToken = {
    apiKey: payload.api_key,
    userPublicId: String(payload.user_public_id ?? ''),
    cacheUntilMs: Math.min(Date.now() + RESOLVE_CACHE_TTL_MS, expiresMs),
  };
  if (resolveCache.size >= RESOLVE_CACHE_MAX) resolveCache.clear();
  resolveCache.set(key, resolved);
  return { ok: true, resolved };
}

// --- Static-bearer fallback (Phase 0.5, flag-gated) ---

interface StaticAuthOutcome {
  authorized: boolean;
  /** The request path with the secret segment (if used) stripped. */
  path: string;
}

function checkStaticAuth(event: FunctionUrlEvent, path: string, secret: string): StaticAuthOutcome {
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
    const started = Date.now();
    const method = event.requestContext?.http?.method ?? 'GET';
    const rawPath = event.rawPath || '/';
    const result = await handleInner(event, method, rawPath, deps, env);
    // One structured line per request; path secrets are redacted to length + hash prefix.
    console.log(
      JSON.stringify({
        method,
        path: redactPath(rawPath),
        status: result.statusCode,
        ms: Date.now() - started,
      }),
    );
    return result;
  };
}

async function handleInner(
  event: FunctionUrlEvent,
  method: string,
  rawPath: string,
  deps: ServerDeps,
  env: NodeJS.ProcessEnv,
): Promise<FunctionUrlResult> {
  const host = event.headers?.host ?? 'lambda';

  // Unauthenticated liveness probe. Reveals nothing beyond liveness.
  if (method === 'GET' && rawPath === '/healthz') {
    return jsonResult(200, { ok: true });
  }

  const issuer = (env.MCP_OAUTH_ISSUER ?? '').trim();
  const serviceKey = (env.MCP_SERVICE_KEY ?? '').trim();
  const oauthEnabled = issuer.length > 0;
  const staticSecret = (env.MCP_BEARER ?? '').trim();
  const staticEnabled =
    env.MCP_STATIC_BEARER_ENABLED === 'true' && staticSecret.length >= MIN_SECRET_LENGTH;

  // RFC 9728 protected-resource metadata: how surfaces discover the authorization server.
  if (method === 'GET' && rawPath === '/.well-known/oauth-protected-resource') {
    if (!oauthEnabled) return jsonResult(404, { error: 'not_found' });
    return jsonResult(200, {
      resource: `https://${host}`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    });
  }

  if (!oauthEnabled && !staticEnabled) {
    return jsonResult(503, { error: 'server_not_configured' });
  }

  const challengeHeaders: Record<string, string> = oauthEnabled
    ? {
        'www-authenticate': `Bearer resource_metadata="https://${host}/.well-known/oauth-protected-resource"`,
      }
    : {};

  // --- Authenticate: static bearer first (flag-gated smoke path), then OAuth resolution ---
  let effectivePath = rawPath;
  let apiKeyOverride: string | undefined;
  let authorized = false;

  if (staticEnabled) {
    const staticAuth = checkStaticAuth(event, rawPath, staticSecret);
    if (staticAuth.authorized) {
      authorized = true;
      effectivePath = staticAuth.path;
    }
  }

  if (!authorized && oauthEnabled) {
    const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!bearerMatch) {
      return jsonResult(401, { error: 'unauthorized' }, challengeHeaders);
    }
    if (!serviceKey) {
      // Fail closed: OAuth advertised but the resolver credential is missing.
      return jsonResult(503, { error: 'server_not_configured' });
    }
    const fetchImpl = (deps.fetchImpl ?? fetch) as typeof fetch;
    const result = await resolveBearer(bearerMatch[1], serviceKey, fetchImpl);
    if (!result.ok) {
      const status = result.error === 'resolve_unavailable' ? 503 : 401;
      return jsonResult(status, { error: result.error }, status === 401 ? challengeHeaders : {});
    }
    authorized = true;
    apiKeyOverride = result.resolved.apiKey;
  }

  if (!authorized) {
    return jsonResult(401, { error: 'unauthorized' }, challengeHeaders);
  }

  // Reconstruct a web-standard Request for the transport. The Authorization header is
  // consumed above and deliberately not forwarded.
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `https://${host}${effectivePath}${query}`;
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
  if (apiKeyOverride) config.apiKey = apiKeyOverride;
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
}

export const handler = makeHandler();
