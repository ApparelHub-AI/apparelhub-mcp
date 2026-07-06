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

/** Bucket an HTTP status into a coarse outcome dimension (bounded cardinality). */
export function outcomeForStatus(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'ok';
}

/** Extract the JSON-RPC method and (for `tools/call`) the tool name from a request body.
 *  Best-effort + safe: any parse failure returns {} so metrics never break a request. */
export function parseRpc(
  body: string | undefined,
  isBase64: boolean,
): { rpcMethod?: string; toolName?: string } {
  if (!body) return {};
  try {
    const text = isBase64 ? Buffer.from(body, 'base64').toString('utf8') : body;
    const parsed = JSON.parse(text) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof first !== 'object' || first === null) return {};
    const rec = first as Record<string, unknown>;
    const rpcMethod = typeof rec.method === 'string' ? rec.method : undefined;
    let toolName: string | undefined;
    if (rpcMethod === 'tools/call' && typeof rec.params === 'object' && rec.params !== null) {
      const n = (rec.params as Record<string, unknown>).name;
      if (typeof n === 'string' && n) toolName = n;
    }
    return { rpcMethod, toolName };
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
