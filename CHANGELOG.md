# Changelog

All notable changes to `@apparelhub/mcp-server` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The agent-facing **tool-surface** contract is versioned separately from the package (spec §10):
this package implements tool surface **v1**.

## [Unreleased]

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
- CI (build + lint + test on Node 20/22) and a stubbed npm-publish workflow.

## [0.1.0] - unreleased

Initial scaffold.
