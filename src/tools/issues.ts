import { z } from 'zod';
import { AhError } from '../errors.js';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, bool, isRecord, num, str, total, viewUrl } from '../util/shape.js';

// Post-sale fulfillment-issue tools (platform epic #510): report a defect on a fulfilled
// order (doesn't match the approved mockup, damaged, wrong item, ...), get the provider-ready
// problem report + dashboard deep-link, track the provider claim to resolution, and create a
// one-click replacement (reship) order.
//
// Contract notes (validated against api/orders.py + common/services/fulfillment_issue_service.py
// and the /agents/v1 twins in api/agents.py):
//   - POST  orders/{order}/issues                      {category, description?, title?,
//                                                       resolution_requested?, shipment_ref?,
//                                                       items:[{order_item_id, quantity_affected?}]}
//     -> 201 {message, issue}. resolution_requested defaults server-side to 'reprint'.
//   - GET   orders/{order}/issues                      -> {issues, eligibility} (order-scoped).
//   - GET   orders/issues?status=&store=&limit=&offset= -> {issues, total} (workspace inbox;
//     status='open_any' = open + submitted_upstream). Static /orders/issues... segments win over
//     /orders/{uuid} in the platform router, so the two GET modes never collide.
//   - GET   orders/issues/{issue}?include_report=true  -> {issue} (+ issue.provider_report).
//   - POST  orders/issues/{issue}/submit-upstream      {provider_claim_ref?} -> {message, issue,
//     provider_report}. Providers accept problem reports ONLY in their own dashboards (verified
//     #511), within ~30 days of delivery — so "submit" records the filing + hands back the
//     copyable summary + dashboard deep-link; it cannot file via API.
//   - POST  orders/issues/{issue}/resolve              {resolution_type, notes?} -> {message, issue}.
//   - POST  orders/issues/{issue}/replacement-order    -> 201 {message, issue,
//     replacement_order_uuid}. Structured 409 refusals: recipient_unavailable (the provider
//     record has no complete address — recipient PII is never stored on ApparelHub orders),
//     variant_unlinked (an affected item isn't linked to a live variant), replacement_exists.
//     Those surface honestly with guidance to create the order manually / reuse the existing one.
//   - Evidence attachments are multipart uploads — out of scope for these tools (the ApparelHub
//     UI handles them); the report/check tools say so instead of pretending.
//
// Mappers are deliberately tolerant of field-name variants so a minor live-API shape difference
// degrades to a missing field rather than a crash.

const enc = encodeURIComponent;

const ISSUE_CATEGORIES = [
  'mockup_mismatch',
  'print_quality',
  'damaged_in_transit',
  'wrong_item',
  'wrong_size_or_color',
  'missing_item',
  'blank_or_mislabeled',
  'late_delivery',
  'lost_in_transit',
  'other',
] as const;

const ISSUE_RESOLUTIONS = [
  'reprint',
  'refund_wallet',
  'refund_customer',
  'replacement_order',
  'other',
  'none',
] as const;

const ISSUE_STATUS_FILTERS = [
  'open_any',
  'open',
  'submitted_upstream',
  'resolved_reprint',
  'resolved_refund',
  'resolved_replacement',
  'resolved_other',
  'rejected',
  'closed',
] as const;

const workspaceField = z
  .string()
  .optional()
  .describe('Workspace uuid to scope to (agency accounts). Omit for the Default workspace.');

const REPORT_NEXT_STEP =
  'Get the provider-ready report with check_fulfillment_issue (include_report) or file it via ' +
  "resolve_fulfillment_issue (action='submit_upstream') — providers accept problem reports only " +
  'in their own dashboard, within 30 days of delivery. Attach photo evidence in the ApparelHub ' +
  'UI (evidence upload needs multipart, not available via this tool).';

const REPORT_GUIDANCE =
  "provider_report.summary_text is copy-paste-ready for the provider's problem-report form — " +
  'open provider_report.dashboard_url and paste it there (providers accept problem reports only ' +
  'in their own dashboard). Evidence files must be re-uploaded on the provider form.';

// ---------------------------------------------------------------------------
// Shared mappers
// ---------------------------------------------------------------------------

/** Drop undefined values so a partial live response reads clean. */
function compact(out: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Unwrap an `{issue: {...}}` envelope if present. */
function issuePayload(raw: unknown): unknown {
  return isRecord(raw) && isRecord(raw.issue) ? raw.issue : raw;
}

function mapEligibility(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  return compact({
    delivered_at: str(raw, 'delivered_at'),
    report_deadline: str(raw, 'report_deadline'),
    days_remaining: num(raw, 'days_remaining'),
    is_within_window: bool(raw, 'is_within_window'),
    basis: str(raw, 'basis'),
  });
}

function mapIssueItem(raw: unknown): Record<string, unknown> {
  return compact({
    uuid: str(raw, 'uuid'),
    order_item_id: num(raw, 'order_item_id') ?? str(raw, 'order_item_id'),
    name: str(raw, 'name'),
    quantity_affected: num(raw, 'quantity_affected'),
    category: str(raw, 'category'),
  });
}

function mapAttachment(raw: unknown): Record<string, unknown> {
  return compact({
    id: str(raw, 'id'),
    filename: str(raw, 'filename'),
    content_type: str(raw, 'content_type'),
    size: num(raw, 'size'),
    status: str(raw, 'status'),
    url: str(raw, 'url'),
  });
}

/** Compact list projection (the inbox / per-order listing). */
function mapIssueListItem(raw: unknown): Record<string, unknown> {
  return compact({
    issue_uuid: str(raw, 'uuid', 'issue_uuid'),
    order_uuid: str(raw, 'order_uuid'),
    order_ref: str(raw, 'order_ref'),
    status: str(raw, 'status'),
    category: str(raw, 'category'),
    category_label: str(raw, 'category_label'),
    title: str(raw, 'title'),
    provider_name: str(raw, 'provider_name'),
    provider_claim_ref: str(raw, 'provider_claim_ref'),
    days_remaining: num(isRecord(raw) ? raw.eligibility : undefined, 'days_remaining'),
    is_open: bool(raw, 'is_open'),
    created: str(raw, 'created', 'created_at'),
  });
}

/** Full issue projection (check_fulfillment_issue + write-tool results). */
function mapIssueDetail(raw: unknown): Record<string, unknown> {
  const orderUuid = str(raw, 'order_uuid');
  const out = compact({
    issue_uuid: str(raw, 'uuid', 'issue_uuid'),
    order_uuid: orderUuid,
    order_ref: str(raw, 'order_ref'),
    source: str(raw, 'source'),
    category: str(raw, 'category'),
    category_label: str(raw, 'category_label'),
    status: str(raw, 'status'),
    is_open: bool(raw, 'is_open'),
    title: str(raw, 'title'),
    description: str(raw, 'description'),
    resolution_requested: str(raw, 'resolution_requested'),
    resolution_type: str(raw, 'resolution_type'),
    resolution_notes: str(raw, 'resolution_notes'),
    provider_name: str(raw, 'provider_name'),
    shipment_ref: str(raw, 'shipment_ref'),
    provider_claim_ref: str(raw, 'provider_claim_ref'),
    provider_claim_status: str(raw, 'provider_claim_status'),
    report_deadline: str(raw, 'report_deadline'),
    eligibility: mapEligibility(isRecord(raw) ? raw.eligibility : undefined),
    replacement_order_uuid: str(raw, 'replacement_order_uuid'),
    submitted_at: str(raw, 'submitted_at'),
    resolved_at: str(raw, 'resolved_at'),
    created: str(raw, 'created', 'created_at'),
  });
  out.warnings = asArray(isRecord(raw) ? raw.warnings : undefined);
  out.items = asArray(isRecord(raw) ? raw.items : undefined).map(mapIssueItem);
  out.attachments = asArray(isRecord(raw) ? raw.attachments : undefined).map(mapAttachment);
  if (orderUuid) out.view_url = viewUrl.order(orderUuid);
  return out;
}

/** The provider-ready problem report (summary + dashboard deep-link). */
function mapProviderReport(raw: unknown): Record<string, unknown> {
  return compact({
    provider: str(raw, 'provider', 'provider_name'),
    dashboard_url: str(raw, 'dashboard_url'),
    summary_text: str(raw, 'summary_text'),
    evidence_count: num(raw, 'evidence_count'),
    warnings: asArray(isRecord(raw) ? raw.warnings : undefined),
  });
}

/** Honest relay for the replacement-order refusals: keep the platform's code + message, add
 *  what-to-do-instead guidance for the three structured 409s (matched on the message text,
 *  which carries the code when the platform sends only {error: <code>}). */
function enrichReplacementError(err: unknown): unknown {
  if (!(err instanceof AhError)) return err;
  const text = err.message.toLowerCase();
  let suggestion: string | undefined;
  if (text.includes('replacement') && (text.includes('exists') || text.includes('already'))) {
    suggestion =
      'A replacement order already exists for this issue — fetch its replacement_order_uuid ' +
      'with check_fulfillment_issue instead of creating another.';
  } else if (text.includes('recipient') || text.includes('address')) {
    suggestion =
      'The platform could not pull a complete recipient address from the fulfillment ' +
      "provider's order record (recipient details are not stored on ApparelHub orders), so it " +
      'cannot build the replacement automatically. Create the replacement order manually with ' +
      "the customer's shipping details, then close the issue with resolve_fulfillment_issue " +
      "(action='resolve', resolution_type='replacement_order').";
  } else if (text.includes('variant')) {
    suggestion =
      'An affected line item is not linked to a live product variant, so the replacement ' +
      'cannot be built automatically. Create the replacement order manually, then close the ' +
      "issue with resolve_fulfillment_issue (action='resolve', " +
      "resolution_type='replacement_order').";
  }
  if (!suggestion) return err;
  return new AhError({
    code: err.code,
    message: err.message,
    httpStatus: err.httpStatus,
    retryAfter: err.retryAfter,
    source: err.source,
    suggestion,
  });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const reportFulfillmentIssue = defineTool({
  name: 'report_fulfillment_issue',
  description:
    'Report a post-sale fulfillment issue (defect) on an order: the item does not match the ' +
    'approved mockup, poor print quality, damaged in transit, wrong/missing item, late or lost. ' +
    'Creates a tracked issue and computes the provider report window (30 days from delivery). ' +
    'Follow up with check_fulfillment_issue for the provider-ready problem report and ' +
    'resolve_fulfillment_issue to file/close it or create a replacement order.',
  inputSchema: z.object({
    order_uuid: z
      .string()
      .min(1)
      .describe('The order the issue is on (from list_my_orders / get_order_details).'),
    category: z
      .enum(ISSUE_CATEGORIES)
      .describe(
        'What went wrong (e.g. mockup_mismatch = print does not match the approved mockup).',
      ),
    description: z
      .string()
      .min(1)
      .describe('What happened, in the words the provider report should carry.'),
    title: z.string().optional().describe('Short title (defaults to the category label).'),
    resolution_requested: z
      .enum(ISSUE_RESOLUTIONS)
      .optional()
      .describe(
        "What to ask the provider for (default 'reprint'). Providers typically resolve as a free reprint or a wallet refund.",
      ),
    items: z
      .array(
        z.object({
          order_item_id: z
            .union([z.number().int(), z.string().min(1)])
            .describe(
              'The order line-item id (issue items returned by these tools carry it as order_item_id).',
            ),
          quantity_affected: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('How many units of this line item are affected (default 1).'),
        }),
      )
      .optional()
      .describe('The affected line items. Omit to report the issue against the order as a whole.'),
    shipment_ref: z
      .string()
      .optional()
      .describe('The shipment reference the issue belongs to (multi-shipment orders).'),
    workspace: workspaceField,
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {
      category: input.category,
      description: input.description,
      resolution_requested: input.resolution_requested ?? 'reprint',
    };
    if (input.title !== undefined) body.title = input.title;
    if (input.shipment_ref !== undefined) body.shipment_ref = input.shipment_ref;
    if (input.items !== undefined) body.items = input.items;
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/issues`, {
      body,
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const issue = issuePayload(raw);
    return compact({
      issue_uuid: str(issue, 'uuid', 'issue_uuid'),
      status: str(issue, 'status'),
      category: str(issue, 'category') ?? input.category,
      order_ref: str(issue, 'order_ref'),
      report_deadline: str(issue, 'report_deadline'),
      days_remaining: num(isRecord(issue) ? issue.eligibility : undefined, 'days_remaining'),
      warnings: asArray(isRecord(issue) ? issue.warnings : undefined),
      view_url: viewUrl.order(input.order_uuid),
      next_step: REPORT_NEXT_STEP,
    });
  },
});

export const listFulfillmentIssues = defineTool({
  name: 'list_fulfillment_issues',
  description:
    "List fulfillment issues. With order_uuid: that order's issues plus its report-window " +
    "eligibility. Without: the workspace-wide issues inbox, filterable by status ('open_any' = " +
    'open + filed upstream) and store, with limit/offset paging. Read-only.',
  inputSchema: z.object({
    order_uuid: z
      .string()
      .optional()
      .describe('Scope to one order (the inbox filters below apply only without it).'),
    status: z
      .enum(ISSUE_STATUS_FILTERS)
      .optional()
      .describe("Inbox filter; 'open_any' = open + submitted_upstream."),
    store: z.string().optional().describe('Inbox filter: a store uuid.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Inbox page size (default 50).'),
    offset: z.number().int().min(0).optional().describe('Inbox page offset.'),
    workspace: workspaceField,
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    if (input.order_uuid) {
      const raw = await ctx.api.get(`orders/${enc(input.order_uuid)}/issues`, {
        workspace: input.workspace,
        signal: ctx.signal,
      });
      const issues = asArray(raw, 'issues').map(mapIssueListItem);
      const out: Record<string, unknown> = {
        order_uuid: input.order_uuid,
        issues,
        total: total(raw, issues.length),
      };
      const eligibility = mapEligibility(isRecord(raw) ? raw.eligibility : undefined);
      if (eligibility) out.eligibility = eligibility;
      return out;
    }
    const raw = await ctx.api.get('orders/issues', {
      query: {
        status: input.status,
        store: input.store,
        limit: input.limit,
        offset: input.offset,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const issues = asArray(raw, 'issues').map(mapIssueListItem);
    return { issues, total: total(raw, issues.length) };
  },
});

export const checkFulfillmentIssue = defineTool({
  name: 'check_fulfillment_issue',
  description:
    'Fetch one fulfillment issue in full (affected items, evidence attachments, provider claim ' +
    'tracking, resolution) and, by default, the provider-ready problem report: a copy-paste ' +
    'summary_text plus the provider dashboard deep-link where the report must be filed ' +
    '(Printful/Printify accept problem reports only in their own dashboards). Read-only.',
  inputSchema: z.object({
    issue_uuid: z.string().min(1).describe('The issue uuid (from list_fulfillment_issues).'),
    include_report: z
      .boolean()
      .optional()
      .describe('Also build the provider-ready problem report (default true).'),
    workspace: workspaceField,
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const includeReport = input.include_report ?? true;
    const raw = await ctx.api.get(`orders/issues/${enc(input.issue_uuid)}`, {
      query: { include_report: includeReport ? 'true' : undefined },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const issue = issuePayload(raw);
    const out = mapIssueDetail(issue);
    if (includeReport) {
      const report = isRecord(issue) ? issue.provider_report : undefined;
      if (report !== undefined) {
        out.provider_report = mapProviderReport(report);
        out.guidance = REPORT_GUIDANCE;
      }
    }
    return out;
  },
});

export const resolveFulfillmentIssue = defineTool({
  name: 'resolve_fulfillment_issue',
  description:
    "Progress a fulfillment issue. action='submit_upstream' records that the problem report was " +
    'filed with the provider (optionally with their claim reference) and returns the dashboard ' +
    "link + summary. action='resolve' closes it with a resolution_type (reprint, refund_wallet, " +
    "refund_customer, replacement_order, other, none). action='create_replacement' builds a " +
    'one-click zero-charge replacement (reship) draft order from the affected items; if it ' +
    'cannot be built automatically (no recipient on the provider record, an unlinked variant, or ' +
    'a replacement already exists) the error says what to do instead.',
  inputSchema: z.object({
    issue_uuid: z.string().min(1).describe('The issue uuid (from list_fulfillment_issues).'),
    action: z
      .enum(['submit_upstream', 'resolve', 'create_replacement'])
      .describe('Which lifecycle step to take.'),
    provider_claim_ref: z
      .string()
      .optional()
      .describe("The provider's claim/case reference (for action='submit_upstream')."),
    resolution_type: z
      .enum(ISSUE_RESOLUTIONS)
      .optional()
      .describe("How the issue was resolved. REQUIRED when action='resolve'."),
    notes: z.string().optional().describe("Resolution notes (for action='resolve')."),
    workspace: workspaceField,
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const id = enc(input.issue_uuid);

    if (input.action === 'submit_upstream') {
      const raw = await ctx.api.post(`orders/issues/${id}/submit-upstream`, {
        body:
          input.provider_claim_ref !== undefined
            ? { provider_claim_ref: input.provider_claim_ref }
            : {},
        workspace: input.workspace,
        signal: ctx.signal,
      });
      const issue = issuePayload(raw);
      const report = isRecord(raw) ? mapProviderReport(raw.provider_report) : {};
      return compact({
        issue_uuid: str(issue, 'uuid', 'issue_uuid') ?? input.issue_uuid,
        action: input.action,
        status: str(issue, 'status'),
        provider_claim_ref: str(issue, 'provider_claim_ref'),
        dashboard_url: report.dashboard_url,
        summary_available: report.summary_text !== undefined,
        message: str(raw, 'message'),
      });
    }

    if (input.action === 'resolve') {
      if (!input.resolution_type) {
        throw new AhError({
          code: 'invalid_input',
          message: "resolution_type is required when action='resolve'.",
          suggestion:
            "Pass resolution_type: one of 'reprint', 'refund_wallet', 'refund_customer', " +
            "'replacement_order', 'other', 'none'.",
        });
      }
      const body: Record<string, unknown> = { resolution_type: input.resolution_type };
      if (input.notes !== undefined) body.notes = input.notes;
      const raw = await ctx.api.post(`orders/issues/${id}/resolve`, {
        body,
        workspace: input.workspace,
        signal: ctx.signal,
      });
      const issue = issuePayload(raw);
      return compact({
        issue_uuid: str(issue, 'uuid', 'issue_uuid') ?? input.issue_uuid,
        action: input.action,
        status: str(issue, 'status'),
        resolution_type: str(issue, 'resolution_type') ?? input.resolution_type,
        resolved_at: str(issue, 'resolved_at'),
        message: str(raw, 'message'),
      });
    }

    // create_replacement
    let raw: unknown;
    try {
      raw = await ctx.api.post(`orders/issues/${id}/replacement-order`, {
        workspace: input.workspace,
        signal: ctx.signal,
      });
    } catch (err) {
      throw enrichReplacementError(err);
    }
    const issue = issuePayload(raw);
    const replacementUuid =
      str(raw, 'replacement_order_uuid') ?? str(issue, 'replacement_order_uuid');
    return compact({
      issue_uuid: str(issue, 'uuid', 'issue_uuid') ?? input.issue_uuid,
      action: input.action,
      status: str(issue, 'status'),
      replacement_order_uuid: replacementUuid,
      ...(replacementUuid ? { view_url: viewUrl.order(replacementUuid) } : {}),
      message: str(raw, 'message'),
    });
  },
});

export const issueTools: ToolDef[] = [
  reportFulfillmentIssue,
  listFulfillmentIssues,
  checkFulfillmentIssue,
  resolveFulfillmentIssue,
];
