import { describe, it, expect } from 'vitest';
import {
  reportFulfillmentIssue,
  listFulfillmentIssues,
  checkFulfillmentIssue,
  resolveFulfillmentIssue,
  issueTools,
} from '../src/tools/issues.js';
import { allTools } from '../src/tools/index.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, queueFetch, noSleep, type RecordedCall } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo — Rule 13): short ids o1/i1/s1/w1/r1, no real account
// data. URL assertions pin the FULL path (house lesson: a loose toContain('/orders') once let a
// wrong-path bug ship).

const BASE = 'https://api.example.test/agents/v1';

function apiStatus(status: number, body: unknown): { api: ApiClient; calls: RecordedCall[] } {
  const { fetchImpl, calls } = queueFetch([jsonResponse(status, body)]);
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: BASE,
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

const apiOk = (body: unknown) => apiStatus(200, body);

describe('registration', () => {
  it('exports the 4 issue tools and wires them into the tool surface', () => {
    const names = issueTools.map((t) => t.name);
    expect(names).toEqual([
      'report_fulfillment_issue',
      'list_fulfillment_issues',
      'check_fulfillment_issue',
      'resolve_fulfillment_issue',
    ]);
    const surface = new Set(allTools().map((t) => t.name));
    for (const n of names) expect(surface.has(n)).toBe(true);
  });

  it('the read tools carry readOnlyHint; the write tools do not', () => {
    expect(listFulfillmentIssues.annotations?.readOnlyHint).toBe(true);
    expect(checkFulfillmentIssue.annotations?.readOnlyHint).toBe(true);
    expect(reportFulfillmentIssue.annotations?.readOnlyHint).toBeUndefined();
    expect(resolveFulfillmentIssue.annotations?.readOnlyHint).toBeUndefined();
  });
});

describe('report_fulfillment_issue', () => {
  const issueBody = {
    message: 'Issue reported',
    issue: {
      uuid: 'i1',
      order_uuid: 'o1',
      order_ref: '#1001',
      status: 'open',
      category: 'mockup_mismatch',
      report_deadline: '2026-08-01T00:00:00',
      eligibility: { days_remaining: 24, is_within_window: true },
      warnings: ['Attach photo evidence before filing.'],
    },
  };

  it('POSTs the full issues path with the body and projects the issue + next_step', async () => {
    const { api, calls } = apiStatus(201, issueBody);
    const res = (await reportFulfillmentIssue.handler(
      {
        order_uuid: 'o1',
        category: 'mockup_mismatch',
        description: 'The printed graphic is shifted left of the approved mockup.',
        title: 'Shifted print',
        resolution_requested: 'reprint',
        items: [{ order_item_id: 7, quantity_affected: 2 }],
        shipment_ref: 'ship-1',
      },
      fakeContext(api),
    )) as any;
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/orders/o1/issues`);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      category: 'mockup_mismatch',
      description: 'The printed graphic is shifted left of the approved mockup.',
      resolution_requested: 'reprint',
      title: 'Shifted print',
      shipment_ref: 'ship-1',
      items: [{ order_item_id: 7, quantity_affected: 2 }],
    });
    expect(res).toMatchObject({
      issue_uuid: 'i1',
      status: 'open',
      category: 'mockup_mismatch',
      order_ref: '#1001',
      report_deadline: '2026-08-01T00:00:00',
      days_remaining: 24,
      warnings: ['Attach photo evidence before filing.'],
      view_url: 'https://apparelhub.ai/orders/o1',
    });
    expect(res.next_step).toContain('check_fulfillment_issue');
    expect(res.next_step).toContain('30 days');
    expect(res.next_step).toContain('multipart');
  });

  it("defaults resolution_requested to 'reprint' and omits absent optional fields", async () => {
    const { api, calls } = apiStatus(201, issueBody);
    await reportFulfillmentIssue.handler(
      { order_uuid: 'o1', category: 'damaged_in_transit', description: 'Box arrived crushed.' },
      fakeContext(api),
    );
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      category: 'damaged_in_transit',
      description: 'Box arrived crushed.',
      resolution_requested: 'reprint',
    });
  });

  it('passes workspace= through to the request', async () => {
    const { api, calls } = apiStatus(201, issueBody);
    await reportFulfillmentIssue.handler(
      { order_uuid: 'o1', category: 'other', description: 'x', workspace: 'w1' },
      fakeContext(api),
    );
    expect(calls[0]?.url).toBe(`${BASE}/orders/o1/issues?workspace=w1`);
  });

  it('rejects a category outside the enum via the input schema', () => {
    const parsed = reportFulfillmentIssue.inputSchema.safeParse({
      order_uuid: 'o1',
      category: 'bogus',
      description: 'x',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('list_fulfillment_issues', () => {
  it('order-scoped mode GETs the per-order path and maps issues + order eligibility', async () => {
    const { api, calls } = apiOk({
      issues: [
        {
          uuid: 'i1',
          order_uuid: 'o1',
          order_ref: '#1001',
          status: 'open',
          category: 'print_quality',
          category_label: 'Print quality (blurry / faded / misprinted)',
          title: 'Faded print',
          provider_name: 'Printful',
          provider_claim_ref: 'C-9',
          is_open: true,
          eligibility: { days_remaining: 12 },
          created: '2026-07-01T00:00:00',
        },
      ],
      eligibility: {
        report_deadline: '2026-07-20T00:00:00',
        days_remaining: 12,
        is_within_window: true,
      },
    });
    const res = (await listFulfillmentIssues.handler(
      { order_uuid: 'o1' },
      fakeContext(api),
    )) as any;
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/orders/o1/issues`);
    expect(res.total).toBe(1);
    expect(res.issues[0]).toMatchObject({
      issue_uuid: 'i1',
      order_uuid: 'o1',
      order_ref: '#1001',
      status: 'open',
      category: 'print_quality',
      title: 'Faded print',
      provider_name: 'Printful',
      provider_claim_ref: 'C-9',
      days_remaining: 12,
      is_open: true,
      created: '2026-07-01T00:00:00',
    });
    expect(res.eligibility).toMatchObject({ days_remaining: 12, is_within_window: true });
  });

  it('inbox mode (no order_uuid) GETs the static issues path with no filter params', async () => {
    const { api, calls } = apiOk({ issues: [], total: 0 });
    const res = (await listFulfillmentIssues.handler({}, fakeContext(api))) as any;
    expect(calls[0]?.url).toBe(`${BASE}/orders/issues`);
    expect(res).toEqual({ issues: [], total: 0 });
  });

  it('inbox mode passes status/store/limit/offset as query params', async () => {
    const { api, calls } = apiOk({ issues: [{ uuid: 'i1' }], total: 41 });
    const res = (await listFulfillmentIssues.handler(
      { status: 'open_any', store: 's1', limit: 10, offset: 5 },
      fakeContext(api),
    )) as any;
    expect(calls[0]?.url).toBe(`${BASE}/orders/issues?status=open_any&store=s1&limit=10&offset=5`);
    expect(res.total).toBe(41);
    expect(res.issues).toHaveLength(1);
  });
});

describe('check_fulfillment_issue', () => {
  const fullIssue = {
    issue: {
      uuid: 'i1',
      order_uuid: 'o1',
      order_ref: '#1001',
      source: 'merchant',
      category: 'wrong_item',
      category_label: 'Wrong item received',
      status: 'submitted_upstream',
      is_open: true,
      title: 'Wrong tee',
      description: 'Received a mug instead of the tee.',
      resolution_requested: 'reprint',
      provider_name: 'Printful',
      shipment_ref: 'ship-1',
      provider_claim_ref: 'C-9',
      provider_claim_status: 'under_review',
      report_deadline: '2026-07-20T00:00:00',
      eligibility: {
        delivered_at: '2026-06-25T00:00:00',
        report_deadline: '2026-07-20T00:00:00',
        days_remaining: 12,
        is_within_window: true,
        basis: 'delivered_at',
      },
      warnings: [],
      items: [{ uuid: 'ii1', order_item_id: 7, name: 'Sunset Tee', quantity_affected: 1 }],
      attachments: [
        {
          id: 'a1',
          filename: 'photo.jpg',
          content_type: 'image/jpeg',
          size: 1024,
          status: 'stored',
          url: 'https://files.example.test/a1',
        },
      ],
      replacement_order_uuid: null,
      submitted_at: '2026-07-02T00:00:00',
      created: '2026-07-01T00:00:00',
      provider_report: {
        provider: 'Printful',
        provider_order_id: 'PF-1',
        dashboard_url: 'https://provider.example/orders/PF-1',
        summary_text: 'Problem report ...',
        evidence_count: 1,
        supports_api_filing: false,
        warnings: ['Providers require photo proof.'],
      },
    },
  };

  it('GETs with include_report=true by default and projects the full issue + provider_report', async () => {
    const { api, calls } = apiOk(fullIssue);
    const res = (await checkFulfillmentIssue.handler(
      { issue_uuid: 'i1' },
      fakeContext(api),
    )) as any;
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/orders/issues/i1?include_report=true`);
    expect(res).toMatchObject({
      issue_uuid: 'i1',
      order_uuid: 'o1',
      order_ref: '#1001',
      source: 'merchant',
      category: 'wrong_item',
      status: 'submitted_upstream',
      is_open: true,
      provider_claim_ref: 'C-9',
      provider_claim_status: 'under_review',
      submitted_at: '2026-07-02T00:00:00',
      view_url: 'https://apparelhub.ai/orders/o1',
    });
    expect(res.eligibility).toMatchObject({ days_remaining: 12, basis: 'delivered_at' });
    expect(res.items).toEqual([
      { uuid: 'ii1', order_item_id: 7, name: 'Sunset Tee', quantity_affected: 1 },
    ]);
    expect(res.attachments[0]).toMatchObject({ id: 'a1', filename: 'photo.jpg', status: 'stored' });
    expect(res.provider_report).toEqual({
      provider: 'Printful',
      dashboard_url: 'https://provider.example/orders/PF-1',
      summary_text: 'Problem report ...',
      evidence_count: 1,
      warnings: ['Providers require photo proof.'],
    });
    expect(res.guidance).toContain('summary_text');
    expect(res.guidance).toContain('copy-paste');
  });

  it('include_report=false omits the query param and returns no provider_report/guidance', async () => {
    const { api, calls } = apiOk({ issue: { uuid: 'i1', order_uuid: 'o1', status: 'open' } });
    const res = (await checkFulfillmentIssue.handler(
      { issue_uuid: 'i1', include_report: false },
      fakeContext(api),
    )) as any;
    expect(calls[0]?.url).toBe(`${BASE}/orders/issues/i1`);
    expect(res).not.toHaveProperty('provider_report');
    expect(res).not.toHaveProperty('guidance');
  });
});

describe('resolve_fulfillment_issue — submit_upstream', () => {
  it('POSTs the submit-upstream path with the claim ref and surfaces the dashboard link', async () => {
    const { api, calls } = apiOk({
      message: 'Issue marked as filed with the provider',
      issue: { uuid: 'i1', status: 'submitted_upstream', provider_claim_ref: 'C-9' },
      provider_report: {
        provider: 'Printful',
        dashboard_url: 'https://provider.example/orders/PF-1',
        summary_text: 'Problem report ...',
        evidence_count: 1,
      },
    });
    const res = (await resolveFulfillmentIssue.handler(
      { issue_uuid: 'i1', action: 'submit_upstream', provider_claim_ref: 'C-9' },
      fakeContext(api),
    )) as any;
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/orders/issues/i1/submit-upstream`);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ provider_claim_ref: 'C-9' });
    expect(res).toMatchObject({
      issue_uuid: 'i1',
      action: 'submit_upstream',
      status: 'submitted_upstream',
      provider_claim_ref: 'C-9',
      dashboard_url: 'https://provider.example/orders/PF-1',
      summary_available: true,
    });
  });

  it('sends an empty body when no claim ref is given', async () => {
    const { api, calls } = apiOk({ issue: { uuid: 'i1', status: 'submitted_upstream' } });
    const res = (await resolveFulfillmentIssue.handler(
      { issue_uuid: 'i1', action: 'submit_upstream' },
      fakeContext(api),
    )) as any;
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({});
    expect(res.summary_available).toBe(false);
  });
});

describe('resolve_fulfillment_issue — resolve', () => {
  it('POSTs the resolve path with resolution_type + notes', async () => {
    const { api, calls } = apiOk({
      message: 'Issue resolved',
      issue: {
        uuid: 'i1',
        status: 'resolved_reprint',
        resolution_type: 'reprint',
        resolved_at: '2026-07-08T00:00:00',
      },
    });
    const res = (await resolveFulfillmentIssue.handler(
      {
        issue_uuid: 'i1',
        action: 'resolve',
        resolution_type: 'reprint',
        notes: 'Provider approved a reprint.',
      },
      fakeContext(api),
    )) as any;
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/orders/issues/i1/resolve`);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      resolution_type: 'reprint',
      notes: 'Provider approved a reprint.',
    });
    expect(res).toMatchObject({
      issue_uuid: 'i1',
      action: 'resolve',
      status: 'resolved_reprint',
      resolution_type: 'reprint',
      resolved_at: '2026-07-08T00:00:00',
    });
  });

  it('rejects action=resolve without resolution_type before any HTTP call', async () => {
    const { api, calls } = apiOk({});
    await expect(
      resolveFulfillmentIssue.handler({ issue_uuid: 'i1', action: 'resolve' }, fakeContext(api)),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('rejects an action outside the enum via the input schema', () => {
    const parsed = resolveFulfillmentIssue.inputSchema.safeParse({
      issue_uuid: 'i1',
      action: 'bogus',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('resolve_fulfillment_issue — create_replacement', () => {
  it('POSTs the replacement-order path and surfaces the new order uuid + view_url', async () => {
    const { api, calls } = apiStatus(201, {
      message: 'Replacement order created as a draft',
      issue: { uuid: 'i1', status: 'open', replacement_order_uuid: 'r1' },
      replacement_order_uuid: 'r1',
    });
    const res = (await resolveFulfillmentIssue.handler(
      { issue_uuid: 'i1', action: 'create_replacement' },
      fakeContext(api),
    )) as any;
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/orders/issues/i1/replacement-order`);
    expect(res).toMatchObject({
      issue_uuid: 'i1',
      action: 'create_replacement',
      replacement_order_uuid: 'r1',
      view_url: 'https://apparelhub.ai/orders/r1',
    });
  });

  it('relays the recipient_unavailable 409 with create-it-manually guidance', async () => {
    const { api } = apiStatus(409, {
      error: 'recipient_unavailable',
      message:
        'The provider order did not include a complete recipient address - create the replacement manually',
    });
    await expect(
      resolveFulfillmentIssue.handler(
        { issue_uuid: 'i1', action: 'create_replacement' },
        fakeContext(api),
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('recipient'),
      suggestion: expect.stringContaining('manually'),
    });
  });

  it('relays the variant_unlinked 409 with create-it-manually guidance', async () => {
    const { api } = apiStatus(409, {
      error: 'variant_unlinked',
      message:
        "Line item 'Sunset Tee' isn't linked to a product variant - create the replacement manually",
    });
    await expect(
      resolveFulfillmentIssue.handler(
        { issue_uuid: 'i1', action: 'create_replacement' },
        fakeContext(api),
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      suggestion: expect.stringContaining('manually'),
    });
  });

  it('relays the replacement_exists 409 pointing at the existing replacement order', async () => {
    const { api } = apiStatus(409, {
      error: 'replacement_exists',
      message: 'A replacement order already exists for this issue',
    });
    await expect(
      resolveFulfillmentIssue.handler(
        { issue_uuid: 'i1', action: 'create_replacement' },
        fakeContext(api),
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      suggestion: expect.stringContaining('check_fulfillment_issue'),
    });
  });
});
