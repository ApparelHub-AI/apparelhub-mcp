# Changelog

All notable changes to `@apparelhub/mcp-server` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The agent-facing **tool-surface** contract is versioned separately from the package (spec §10):
this package implements tool surface **v1**.

## [Unreleased]

## [0.2.4] - 2026-07-06

### Added

- **Connector-traffic observability (epic #36).** The hosted Lambda now emits one CloudWatch EMF
  metric per request (namespace `ApparelHub/MCP`): `Requests` + `LatencyMs`, dimensioned by
  `Outcome` and (for tool calls) `ToolName` — no per-identity dimension (low cardinality, no user
  data). A `${stack}-connector` dashboard (one per account) shows requests by outcome, tool-call
  volume by tool, latency p50/p99, and Lambda health. Rate limiting (per-connector AWS usage plan)
  and the paid-op spend cap (per-account image-generation limit) are inherited from the platform;
  see `docs/connector-controls.md`.


## [0.2.3] - 2026-07-06

### Fixed

- **`list_my_stores` now shows the fulfillment provider (and sales channels).** The store mapper
  read the wrong field names — `merchandise_providers`/`fulfillment_providers` and
  `ecommerce_integrations`/`integrations` — but the platform returns fulfillment under `providers`
  and channels under `active_integrations`. So every store came back "no fulfillment provider
  connected", which is impossible by design (a store always has one). Now reads the correct fields
  (old names kept as fallbacks). Sales channels also require the platform's store-list serializer to
  include `active_integrations` (apparelhub-ai#502).

## [0.2.2] - 2026-07-05

### Fixed

- **`design_apparel` no longer aborts an otherwise-good design when the keying step hard-fails.**
  Belt-and-suspenders for unattended runs: `process_transparency` already auto-recovers a tinted-green
  background in dominance mode (0.2.1), so if keying still can't finish (missing toolchain / a hard
  keyer failure) the design is kept with `transparency_clean: false` + a clear warning instead of
  crashing the run. Transient / auth errors (rate limit, upstream 503, auth) still surface so a
  scheduled run retries rather than silently shipping an unkeyed design.

### Changed

- **Hosted deploy: the platform base URL is now env-configurable (`APPARELHUB_API_BASE_URL`)** so the
  dev-account hosted server can integrate with the dev platform (`api.dev.apparelhub.ai`) instead of
  being a second door to prod (#35 dev domain). It flows through both tool calls and OAuth token
  resolution. The **stdio** server is unchanged — its base stays hardcoded and NOT overridable
  (a user must not be able to redirect their own key); the override is honored only in the hosted
  Lambda, whose environment is set solely by our IaC.

## [0.2.1] - 2026-07-05

### Fixed

- **Transparency keying no longer dead-ends on a tinted green background.** AI image models routinely
  render the "solid #00FF00" background as a tinted/muted green (e.g. `#80E77B`, `#A6FB93`), which the
  box keyer's chroma sanity check refused (to protect warm design elements) — with no way to override.
  A real unattended run got stuck regenerating a pure-monochrome design over and over. `process_transparency`
  (and `design_apparel`) now **auto-recover** by re-keying in green-dominance mode, which strips a tinted
  green screen safely (it only clears pixels where green clearly outweighs red *and* blue, so charcoal /
  white / warm art is preserved), and reports `keying_mode` + a note. New optional `background_mode`
  (`auto`/`box`/`dominance`) and `force` params let a caller pin the strategy. The generation prompt also
  pushes harder toward a flat, fully-saturated pure #00FF00 (no gradient/tint) to avoid the situation in
  the first place.

## [0.2.0] - 2026-07-05

### Added

- **48 capability tools** (surface grows 26 → 74) closing the read/act parity gaps a tool-vs-API
  audit found — the connector could read/create/sync but couldn't *manage* what exists — plus a
  generic escape hatch so a missing tool never blocks a user:
  - **Workspaces**: `list_my_workspaces` (resolve a workspace/client name to its uuid; the
    read/write tools already accept `workspace=<uuid>`).
  - **Orders**: lifecycle (`approve_order`, `unapprove_order`, `hold_order`, `cancel_order`,
    `confirm_order`, `submit_order_to_fulfillment`, `check_order_status`, `reconcile_order`) and
    design-approval holds (`list_order_holds`, `approve_order_hold`, `request_hold_changes`).
  - **Analytics**: `analytics_summary`, `analytics_timeseries`, `analytics_breakdown`,
    `analytics_ops`, `analytics_portfolio`.
  - **Collections**: full CRUD + `add_products_to_collection` / `remove_product_from_collection` /
    `sync_collection`.
  - **Cross-workspace transfer**: copy/move products + designs, each with a move-eligibility dry run.
  - **Store & order management**: store settings/lifecycle, order payment/ops, product
    archive/restore.
  - **Escape hatch**: `get_api_reference` (self-discover the agent API from the live OpenAPI spec)
    and `api_request` (call any `/agents/v1` endpoint; path-guarded against host escape + `..`).

### Changed

- The public-repo hygiene CI guard now keeps its forbidden-term list in a repo secret (it had
  hardcoded the very terms it forbids) and runs quiet, so no term/UUID/host reaches build logs.

## [0.1.1] - 2026-07-04

### Fixed

- Catalog provider discovery called `GET /merchandise`, a route that does not exist on the
  platform (404 -> every `browse_catalog` / `get_garment_details` call failed with `not_found`).
  The correct route is `GET /merchandise/providers`. Caught by the first real-surface field test
  of the hosted prototype (#38).
- Catalog mappers now read the live platform field names: listings carry the garment id as a
  numeric `provider_ref_id`, detail variants carry their id as `provider_ref_id` with string
  prices, Printful returns print templates per-variant (top-level `template_details` can be
  empty), and placement lives under `provider_location_ref_id`. Regression tests mirror the live
  response shapes.

### Added

- AWS Lambda Function URL entry point (`src/http/lambda.ts`): serves the tool surface over MCP
  streamable HTTP in stateless mode with JSON responses, static-bearer auth (header or
  path-embedded), fail-closed configuration, and an unauthenticated liveness probe. Plus a
  disposable SAM deployment under `deploy/prototype/` (hosted Phase 0.5, #38; the production
  hosted service with OAuth is the remote-MCP epic #31).

## [0.1.0] - 2026-07-02

### Added

- Foundation: MCP server over stdio, connection-level API-key auth, retry-aware REST client,
  structured error contract, progress-notification helper, telemetry opt-out shell, and the
  local-image bridge scaffold.
- Read tools: `list_my_stores`, `list_my_designs`, `list_my_products`, `list_my_orders`,
  `get_order_details`.
- Catalog tools: `browse_catalog`, `get_garment_details`, `recommend_garment`, with embedded
  garment knowledge (pricing floors, quality tiers, the BC 3001 AQUA-vs-Navy variant trap).
- Design tools: `design_apparel` + `iterate_design` and the split primitives `generate_image`,
  `process_transparency`, `verify_design_text`. Async-generation polling, local transparency
  keying (bundled `make_transparent.py`) with a dependency-named degrade notice, local OCR text
  detection, and the placement-dimensions helper.
- Product tools: `ship_product` + `update_product` / `delete_product` and split primitives
  `create_product`, `add_variants`, `sync_to_fulfillment`, `sync_to_channel`. Encodes the
  7-phase pipeline: correct create field names, two-phase mockup poll, variants-before-sync,
  fulfillment-before-ecommerce, draft-not-live default, pricing-floor enforcement, and the
  AQUA-vs-Navy variant guard.
- Systems of action: `analyze_what_works`, `auto_optimize_listings`, `cascade_price_change`,
  `recover_from_outage`. Own-account analytics, dry-run-by-default mutations that only take safe
  actions (archive not delete, keep listing state, respect floors), and failed-sync recovery.
- Safety tools: `verify_design_quality` (local QC gate: alpha/corners/premultiply, resolution,
  detected text; bundled `image_stats.py`) and `check_design_compliance` (advisory trademark /
  prohibited-content text heuristic with a clear disclaimer).
- Telemetry: a minimal, privacy-bounded per-tool-call signal (tool, outcome, error code, latency,
  and a strict allowlist of coarse features), buffered + fire-and-forget, off via
  `APPARELHUB_MCP_TELEMETRY=off`. The ingest endpoint is a pending backend workstream.
- Docs: full README (install + MCP config snippets for Claude Code / Cursor / Aider / claude.ai,
  env vars, privacy, skill-vs-MCP), a tool reference (`docs/TOOLS.md`), and a release runbook
  (`docs/RELEASING.md`). CI actions bumped to v5.
- CI (build + lint + test on Node 20/22) and a stubbed npm-publish workflow.

