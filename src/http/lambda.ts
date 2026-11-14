import { createHash, timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { API_BASE_URL, loadConfig } from '../config.js';
import { createServer, type ServerDeps } from '../server.js';
import { emitConnectorMetric, outcomeForStatus, parseRpc } from './metrics.js';

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

// --- CORS (apparelhub-mcp#44 follow-up) ---
//
// Editor clients that issue MCP requests from a browser/renderer context are
// subject to CORS. Two things were missing and BOTH are hard blockers there:
//
//   1. The OPTIONS preflight went through auth and returned 401. A preflight is
//      unauthenticated by definition -- browsers never attach credentials to it
//      -- so it must short-circuit before any auth runs, or the real request is
//      never sent and the client reports the server as unreachable.
//
//   2. `WWW-Authenticate` was not exposed. Restoring the header at the CDN is
//      not enough on its own: a browser context cannot READ a response header
//      unless it is listed in Access-Control-Expose-Headers, so the OAuth
//      challenge stayed invisible to exactly the clients that need it.
//
// `Allow-Origin: *` rather than echoing Origin, because MCP clients authenticate
// with an explicit Authorization header, never cookies -- so credentialed mode
// is not needed and the wildcard keeps this cacheable.
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '86400',
};

function jsonResult(
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): FunctionUrlResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
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

/**
 * The platform base URL this HOSTED server talks to. Unlike the stdio server (whose base is
 * hardcoded and NOT env-overridable — a user must not be able to redirect their own key, see
 * config.ts), the hosted Lambda's environment is set only by us via IaC (SAM parameter ->
 * `APPARELHUB_API_BASE_URL`). That lets the dev-account deploy integrate with the dev platform
 * (api.dev.apparelhub.ai) while prod stays on api.apparelhub.ai. Falls back to the prod default.
 */
function hostedApiBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.APPARELHUB_API_BASE_URL ?? '').trim() || API_BASE_URL;
}

async function resolveBearer(
  raw: string,
  serviceKey: string,
  baseUrl: string,
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
    response = await fetchImpl(`${baseUrl}/service/connector/resolve-token`, {
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

// --- Settlement guarantees (an internal platform ticket) ---
//
// A Node Lambda dies with Runtime.NodeJsExit ("a Promise that was never settled") when the
// event loop goes empty while the handler's promise is still pending: nothing is left that
// could ever settle it, so Node exits, the invocation fails, and no access line is written.
// That is exactly what an authenticated `GET` did: the SDK answered it with an open-ended SSE
// stream that nothing in a stateless, one-request-per-invocation server ever writes to or
// closes, and draining it (`await response.text()`) waited on a promise with no timer or
// socket behind it. The primary fix is the 405 below; these guards make sure the NEXT path of
// the same shape fails as a logged, retryable error instead of a silent runtime crash.

/** The subset of the Lambda context object this handler reads. */
export interface InvocationContext {
  getRemainingTimeInMillis?: () => number;
}

/**
 * How long before the Lambda deadline the guard answers. Enough to serialize the error and hand
 * it back to the runtime before the platform kills the sandbox.
 */
const DEADLINE_MARGIN_MS = 1000;
/** Used when no Lambda context is available (local invocation). Below the 300 s function timeout. */
const DEFAULT_DEADLINE_MS = 290_000;
/** JSON-RPC "Internal error". The message tells the agent it may retry. */
const INTERNAL_ERROR_CODE = -32603;

function internalErrorResult(statusCode: number, message: string): FunctionUrlResult {
  return jsonResult(statusCode, {
    jsonrpc: '2.0',
    id: null,
    error: { code: INTERNAL_ERROR_CODE, message },
  });
}

function deadlineFor(context: InvocationContext | undefined): number {
  const remaining = context?.getRemainingTimeInMillis?.();
  if (typeof remaining === 'number' && Number.isFinite(remaining)) {
    return Math.max(0, remaining - DEADLINE_MARGIN_MS);
  }
  return DEFAULT_DEADLINE_MS;
}

type GuardOutcome =
  | { kind: 'ok'; result: FunctionUrlResult }
  | { kind: 'threw'; error: unknown }
  | { kind: 'deadline' };

/**
 * Race the request against a REF'd timer. The timer has two jobs: it keeps the event loop
 * non-empty, so an orphaned promise can no longer let Node exit underneath a pending handler,
 * and when it fires it settles the invocation with an error we log. Cleared as soon as the work
 * settles, so a normal request pays nothing.
 */
async function settleWithin(
  work: () => Promise<FunctionUrlResult>,
  deadlineMs: number,
): Promise<GuardOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<GuardOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'deadline' }), deadlineMs);
  });
  const attempt = work().then(
    (result): GuardOutcome => ({ kind: 'ok', result }),
    (error: unknown): GuardOutcome => ({ kind: 'threw', error }),
  );
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function errorSummary(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: typeof error, message: String(error) };
}

/**
 * Build the handler with injectable server deps (tests pass a fake `fetchImpl`) and env.
 * The default export below is the production wiring.
 */
export function makeHandler(
  deps: ServerDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): (event: FunctionUrlEvent, context?: InvocationContext) => Promise<FunctionUrlResult> {
  return async function handle(
    event: FunctionUrlEvent,
    context?: InvocationContext,
  ): Promise<FunctionUrlResult> {
    const started = Date.now();
    const method = event.requestContext?.http?.method ?? 'GET';
    const rawPath = event.rawPath || '/';
    // Answer the preflight before anything else. Placed in the OUTER handler on
    // purpose: handleInner owns auth, and a preflight that reaches auth gets a
    // 401, which kills the request the browser was about to make.
    const outcome: GuardOutcome =
      method === 'OPTIONS'
        ? { kind: 'ok', result: { statusCode: 204, headers: { ...CORS_HEADERS }, body: '' } }
        : await settleWithin(
            () => handleInner(event, method, rawPath, deps, env),
            deadlineFor(context),
          );
    let result: FunctionUrlResult;
    let failure: string | undefined;
    if (outcome.kind === 'ok') {
      result = outcome.result;
    } else if (outcome.kind === 'threw') {
      failure = 'unhandled_error';
      const { name, message } = errorSummary(outcome.error);
      console.error(
        JSON.stringify({
          event: 'request_failed',
          reason: failure,
          method,
          path: redactPath(rawPath),
          name,
          message,
        }),
      );
      result = internalErrorResult(500, 'Internal error, please retry.');
    } else {
      failure = 'deadline_exceeded';
      console.error(
        JSON.stringify({
          event: 'request_failed',
          reason: failure,
          method,
          path: redactPath(rawPath),
          ms: Date.now() - started,
        }),
      );
      result = internalErrorResult(504, 'The request did not finish in time, please retry.');
    }
    const latencyMs = Date.now() - started;
    const { rpcMethod, toolName } =
      method === 'POST' ? parseRpc(event.body, event.isBase64Encoded === true) : {};
    // One structured line per request; path secrets are redacted to length + hash prefix.
    console.log(
      JSON.stringify({
        method,
        path: redactPath(rawPath),
        status: result.statusCode,
        ms: latencyMs,
        rpc: rpcMethod,
        tool: toolName,
        ...(failure ? { failure } : {}),
      }),
    );
    // Connector-traffic metrics (#36). Skip the unauthenticated liveness probe so health
    // checks don't drown the real traffic signal.
    if (rawPath !== '/healthz') {
      emitConnectorMetric({ outcome: outcomeForStatus(result.statusCode), latencyMs, toolName });
    }
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
  // Behind CloudFront (mcp.apparelhub.ai) the Lambda Function URL requires its
  // own Host header, so CloudFront rewrites Host to the *.lambda-url origin and
  // forwards the branded hostname as X-Forwarded-Host. Prefer that so the OAuth
  // protected-resource metadata + WWW-Authenticate challenge advertise the
  // public domain, not the raw Function URL. Direct Function-URL hits (no
  // CloudFront, no X-Forwarded-Host) fall back to Host unchanged.
  const host = event.headers?.['x-forwarded-host'] ?? event.headers?.host ?? 'lambda';

  // Unauthenticated liveness probe. Reveals nothing beyond liveness.
  if (method === 'GET' && rawPath === '/healthz') {
    return jsonResult(200, { ok: true });
  }

  const issuer = (env.MCP_OAUTH_ISSUER ?? '').trim();
  const serviceKey = (env.MCP_SERVICE_KEY ?? '').trim();
  const apiBaseUrl = hostedApiBaseUrl(env);
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
    const result = await resolveBearer(bearerMatch[1], serviceKey, apiBaseUrl, fetchImpl);
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

  // A stateless server cannot hold a standalone SSE stream: there is no later invocation that
  // could write to it, and nothing ever closes it. Handing the GET to the SDK produced exactly
  // that stream, and draining it never settled. The Streamable HTTP spec lets a server
  // that offers no GET stream answer 405, and clients then carry on over POST.
  if (method === 'GET') {
    return jsonResult(
      405,
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: 'Method not allowed: this server does not offer a GET stream. Use POST.',
        },
      },
      { allow: 'POST, DELETE, OPTIONS' },
    );
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
  // loadConfig hardcodes the prod base (stdio security posture); the hosted deploy may point at
  // the dev platform via APPARELHUB_API_BASE_URL. Override here so tool calls + resolve-token
  // both hit the same environment.
  config.baseUrl = apiBaseUrl;
  if (apiKeyOverride) config.apiKey = apiKeyOverride;
  const { server } = createServer(config, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    // With enableJsonResponse every answer we serve is a complete JSON body. A streaming answer
    // here means a path that would wait forever on a stream nobody closes, so refuse it
    // loudly rather than drain it.
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // Best-effort cleanup only: the error thrown next is what gets reported.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`transport returned an event stream for ${method}; refusing to drain it`);
    }
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
