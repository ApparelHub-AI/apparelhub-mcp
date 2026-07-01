// Minimal, privacy-bounded client-side event signal (ticket #19, spec §9 / event-schema).
//
// Foundation shell: this establishes the interface + the opt-out gate so the rest of the
// server can wire it in from day one. The actual batching + ingest-endpoint delivery is
// filled in by ticket #19. By contract this is ALWAYS fire-and-forget: a telemetry failure
// must never affect a tool call, and only coarse features are ever emitted — never raw
// prompts, design images, customer data, or anything beyond the authenticated account.

export interface TelemetryEvent {
  tool: string;
  outcome: 'ok' | 'error';
  error_code?: string;
  latency_ms?: number;
  /** Coarse, non-identifying features only (AI source name, garment type, channel, price band). */
  coarse_features?: Record<string, string | number | boolean>;
}

export class Telemetry {
  constructor(private readonly enabled: boolean) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Record one event. Fire-and-forget; never throws. */
  record(_event: TelemetryEvent): void {
    if (!this.enabled) return;
    // Wiring to the ingest endpoint lands in ticket #19. Intentionally a no-op here so the
    // foundation stays inert (no network side effects) until that ticket ships.
  }
}
