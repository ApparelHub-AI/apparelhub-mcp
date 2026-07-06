import { describe, it, expect } from 'vitest';
import {
  METRICS_NAMESPACE,
  outcomeForStatus,
  parseRpc,
  buildEmf,
  emitConnectorMetric,
} from '../src/http/metrics.js';

describe('outcomeForStatus', () => {
  it('buckets statuses into coarse outcomes', () => {
    expect(outcomeForStatus(200)).toBe('ok');
    expect(outcomeForStatus(401)).toBe('unauthorized');
    expect(outcomeForStatus(429)).toBe('rate_limited');
    expect(outcomeForStatus(400)).toBe('client_error');
    expect(outcomeForStatus(404)).toBe('client_error');
    expect(outcomeForStatus(500)).toBe('server_error');
    expect(outcomeForStatus(503)).toBe('server_error');
  });
});

describe('parseRpc', () => {
  it('extracts the tool name from a tools/call body', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_my_stores', arguments: {} } });
    expect(parseRpc(body, false)).toEqual({ rpcMethod: 'tools/call', toolName: 'list_my_stores' });
  });

  it('returns the method but no tool name for non-tool calls', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(parseRpc(body, false)).toEqual({ rpcMethod: 'tools/list', toolName: undefined });
  });

  it('decodes a base64 body', () => {
    const raw = JSON.stringify({ method: 'tools/call', params: { name: 'ship_product' } });
    const b64 = Buffer.from(raw, 'utf8').toString('base64');
    expect(parseRpc(b64, true)).toEqual({ rpcMethod: 'tools/call', toolName: 'ship_product' });
  });

  it('handles a JSON-RPC batch (first entry) and never throws on junk', () => {
    const batch = JSON.stringify([{ method: 'tools/call', params: { name: 'get_order_details' } }]);
    expect(parseRpc(batch, false).toolName).toBe('get_order_details');
    expect(parseRpc('not json', false)).toEqual({});
    expect(parseRpc(undefined, false)).toEqual({});
    expect(parseRpc('{}', false)).toEqual({});
  });
});

describe('buildEmf', () => {
  it('emits Requests + LatencyMs keyed by Outcome and ToolName for a tool call', () => {
    const emf = buildEmf({ outcome: 'ok', latencyMs: 42, toolName: 'list_my_stores', now: 1000 }) as any;
    expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe(METRICS_NAMESPACE);
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Outcome'], ['ToolName']]);
    expect(emf._aws.CloudWatchMetrics[0].Metrics.map((m: any) => m.Name)).toEqual(['Requests', 'LatencyMs']);
    expect(emf.Outcome).toBe('ok');
    expect(emf.ToolName).toBe('list_my_stores');
    expect(emf.Requests).toBe(1);
    expect(emf.LatencyMs).toBe(42);
  });

  it('omits the ToolName dimension when there is no tool (e.g. an auth failure)', () => {
    const emf = buildEmf({ outcome: 'unauthorized', latencyMs: 5, now: 1 }) as any;
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Outcome']]);
    expect(emf).not.toHaveProperty('ToolName');
  });

  it('never emits a per-identity dimension (low cardinality guard)', () => {
    const emf = buildEmf({ outcome: 'ok', latencyMs: 1, toolName: 'x', now: 1 }) as any;
    const dims = emf._aws.CloudWatchMetrics[0].Dimensions.flat();
    expect(dims).not.toContain('User');
    expect(dims).not.toContain('UserId');
    expect(dims.every((d: string) => d === 'Outcome' || d === 'ToolName')).toBe(true);
  });
});

describe('emitConnectorMetric', () => {
  it('emits one valid JSON EMF line via the injected sink', () => {
    const lines: string[] = [];
    emitConnectorMetric({ outcome: 'ok', latencyMs: 10, toolName: 'design_apparel', now: 1, emit: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ToolName).toBe('design_apparel');
    expect(parsed._aws.CloudWatchMetrics[0].Namespace).toBe(METRICS_NAMESPACE);
  });
});
