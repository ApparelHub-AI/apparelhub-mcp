import { describe, it, expect } from 'vitest';
import { Telemetry, type TelemetryEvent } from '../src/telemetry.js';

describe('Telemetry', () => {
  it('buffers and auto-flushes a batch when the buffer fills', async () => {
    const sent: TelemetryEvent[] = [];
    const t = new Telemetry(true, async (events) => void sent.push(...events), 2);
    t.record({ tool: 'a', outcome: 'ok', latency_ms: 5 });
    expect(t.pending()).toBe(1);
    t.record({ tool: 'b', outcome: 'error', error_code: 'x' }); // reaches maxBuffer -> flush
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
  });

  it('does nothing when disabled (opt-out)', async () => {
    let called = false;
    const t = new Telemetry(false, async () => void (called = true));
    t.record({ tool: 'a', outcome: 'ok' });
    await t.flush();
    expect(called).toBe(false);
    expect(t.pending()).toBe(0);
  });

  it('sanitizes coarse_features down to flat scalars', async () => {
    let batch: TelemetryEvent[] = [];
    const t = new Telemetry(true, async (e) => void (batch = e), 100);
    t.record({
      tool: 'a',
      outcome: 'ok',
      coarse_features: {
        source: 'Nano Banana',
        count: 3,
        nested: { x: 1 } as unknown as string,
        arr: [1] as unknown as string,
      },
    });
    await t.flush();
    expect(batch[0]?.coarse_features).toEqual({ source: 'Nano Banana', count: 3 });
  });

  it('swallows sender failures (fire-and-forget)', async () => {
    const t = new Telemetry(true, async () => {
      throw new Error('boom');
    }, 100);
    t.record({ tool: 'a', outcome: 'ok' });
    await expect(t.flush()).resolves.toBeUndefined();
  });
});
