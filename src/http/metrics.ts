// Connector observability (remote-MCP epic #36).
//
// The hosted Lambda emits ONE CloudWatch Embedded Metric Format (EMF) line per request, so
// connector traffic shows up as metrics (request volume by outcome, tool-call volume by tool,
// latency) with NO PutMetricData call — CloudWatch Logs auto-extracts the metrics from the log.
//
// Deliberately LOW cardinality: the only dimensions are a coarse `Outcome` bucket and the
// `ToolName` (a bounded set). It NEVER emits per-user / per-identity dimensions (that would be
// high-cardinality + a privacy leak). Per-identity rate limiting + the paid-op spend cap are
// enforced upstream (the connector key's AWS usage plan + the per-account image-generation cap),
// so this module is purely observability.

export const METRICS_NAMESPACE = 'ApparelHub/MCP';

/** Bucket an HTTP status into a coarse outcome dimension (bounded cardinality).
 *
 *  `eraProbe` marks a request sent in the 2026-07-28 ("modern") protocol shape, which this
 *  server does not speak yet (#1433). Its 400 is the answer the spec asks of a legacy server
 *  and is what tells a dual-era client to fall back to `initialize`, so it is NOT a client
 *  error and must not be counted as one: counting it there is what made the error-triage scan
 *  file it as a platform fault. */
export function outcomeForStatus(status: number, eraProbe = false): string {
  if (eraProbe && status === 400) return 'legacy_fallback';
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'ok';
}

/** `_meta` key a modern (2026-07-28+) request uses to declare its protocol version. */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
/** `_meta` key a modern request uses to carry client identity (replaces initialize's clientInfo). */
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

/** Client-supplied text goes into a log line: keep it short and printable. */
function cleanLabel(v: unknown, max = 64): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, max);
  return s || undefined;
}

function clientLabel(info: unknown): string | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  const rec = info as Record<string, unknown>;
  const name = cleanLabel(rec.name);
  if (!name) return undefined;
  const version = cleanLabel(rec.version, 32);
  return version ? `${name}/${version}` : name;
}

export interface RpcSummary {
  rpcMethod?: string;
  toolName?: string;
  /** Protocol version the body declares: modern `_meta`, or `params.protocolVersion` on initialize. */
  protocolVersion?: string;
  /** `name/version` of the calling client, when the body says (initialize or modern `_meta`). */
  client?: string;
}

/** Extract the JSON-RPC method, (for `tools/call`) the tool name, and the declared protocol
 *  version + client identity from a request body. The last two are for the access log only:
 *  they let us see which clients probe in the modern shape and whether they then initialize.
 *  Never metric dimensions (unbounded). Best-effort + safe: any parse failure returns {} so
 *  metrics never break a request. */
export function parseRpc(body: string | undefined, isBase64: boolean): RpcSummary {
  if (!body) return {};
  try {
    const text = isBase64 ? Buffer.from(body, 'base64').toString('utf8') : body;
    const parsed = JSON.parse(text) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof first !== 'object' || first === null) return {};
    const rec = first as Record<string, unknown>;
    const rpcMethod = typeof rec.method === 'string' ? rec.method : undefined;
    let toolName: string | undefined;
    let protocolVersion: string | undefined;
    let client: string | undefined;
    if (typeof rec.params === 'object' && rec.params !== null) {
      const params = rec.params as Record<string, unknown>;
      if (rpcMethod === 'tools/call' && typeof params.name === 'string' && params.name) {
        toolName = params.name;
      }
      const meta =
        typeof params._meta === 'object' && params._meta !== null
          ? (params._meta as Record<string, unknown>)
          : {};
      protocolVersion = cleanLabel(meta[META_PROTOCOL_VERSION] ?? params.protocolVersion, 32);
      client = clientLabel(meta[META_CLIENT_INFO] ?? params.clientInfo);
    }
    return {
      rpcMethod,
      toolName,
      ...(protocolVersion ? { protocolVersion } : {}),
      ...(client ? { client } : {}),
    };
  } catch {
    return {};
  }
}

export interface ConnectorMetric {
  outcome: string;
  latencyMs: number;
  toolName?: string;
  /** Injectable for tests (defaults to Date.now()). */
  now?: number;
  /** Injectable for tests (defaults to console.log). */
  emit?: (line: string) => void;
}

/** Build the EMF payload for a request: `Requests` (Count) + `LatencyMs` (Milliseconds),
 *  emitted per `Outcome` and (for tool calls) per `ToolName`. Exposed for tests. */
export function buildEmf(m: ConnectorMetric): Record<string, unknown> {
  const dimensions: string[][] = [['Outcome']];
  if (m.toolName) dimensions.push(['ToolName']);
  return {
    _aws: {
      Timestamp: m.now ?? Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: METRICS_NAMESPACE,
          Dimensions: dimensions,
          Metrics: [
            { Name: 'Requests', Unit: 'Count' },
            { Name: 'LatencyMs', Unit: 'Milliseconds' },
          ],
        },
      ],
    },
    Outcome: m.outcome,
    ...(m.toolName ? { ToolName: m.toolName } : {}),
    Requests: 1,
    LatencyMs: m.latencyMs,
  };
}

/** Emit one EMF metric line (fire-and-forget; never throws into the request path). */
export function emitConnectorMetric(m: ConnectorMetric): void {
  try {
    (m.emit ?? console.log)(JSON.stringify(buildEmf(m)));
  } catch {
    /* metrics must never break a request */
  }
}
