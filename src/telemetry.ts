// Minimal, privacy-bounded client-side event signal (ticket #19, spec §9 / event-schema).
//
// Contract:
//  - ALWAYS fire-and-forget: a telemetry failure must never affect a tool call.
//  - Only coarse, non-identifying features are ever emitted — never raw prompts, design images,
//    customer data, or ids. `sanitize()` enforces this in code (coarse_features must be flat
//    scalars), and the caller pre-filters via a per-tool allowlist.
//  - Off entirely when APPARELHUB_MCP_TELEMETRY=off.
//
// Backend dependency: the ingest endpoint (POST /agents/v1/telemetry) is a separate apparelhub-ai
// workstream. Until it ships, batched sends simply fail silently (fire-and-forget), which is the
// intended behavior — the client is correct and the backend catches up.

export interface TelemetryEvent {
  tool: string;
  outcome: 'ok' | 'error';
  error_code?: string;
  latency_ms?: number;
  /** Coarse, non-identifying features only (e.g. AI source name, garment type, channel). */
  coarse_features?: Record<string, string | number | boolean>;
}

export type TelemetrySender = (events: TelemetryEvent[]) => Promise<void>;

/** Drop anything that isn't an allowed coarse field. Defense-in-depth for the privacy boundary. */
function sanitize(e: TelemetryEvent): TelemetryEvent {
  const out: TelemetryEvent = { tool: e.tool, outcome: e.outcome };
  if (e.error_code) out.error_code = e.error_code;
  if (typeof e.latency_ms === 'number') out.latency_ms = e.latency_ms;
  if (e.coarse_features) {
    const cf: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(e.coarse_features)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') cf[k] = v;
    }
    if (Object.keys(cf).length) out.coarse_features = cf;
  }
  return out;
}

export class Telemetry {
  private buffer: TelemetryEvent[] = [];
  private readonly maxBuffer: number;

  constructor(
    private readonly enabled: boolean,
    private readonly sender?: TelemetrySender,
    maxBuffer = 20,
  ) {
    this.maxBuffer = maxBuffer;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Record one event. Fire-and-forget; never throws. Flushes when the buffer fills. */
  record(event: TelemetryEvent): void {
    if (!this.enabled) return;
    this.buffer.push(sanitize(event));
    if (this.buffer.length >= this.maxBuffer) void this.flush();
  }

  /** Send + clear the buffer. Best-effort: swallows send failures. */
  async flush(): Promise<void> {
    if (!this.enabled || !this.sender || this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await this.sender(batch);
    } catch {
      // Fire-and-forget by contract. A failed telemetry send never affects tools, and there is
      // no retry (events are best-effort). Silent on purpose.
    }
  }

  pending(): number {
    return this.buffer.length;
  }
}
