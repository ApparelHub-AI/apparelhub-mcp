# Tool reference

The full tool surface (v1). Call `tools/list` from your agent for the live JSON schemas; this is
the human-readable summary. Read tools are read-only; mutating tools default to safe behavior
(draft not live, dry-run, pricing floors) as noted.

## Read

| Tool | Summary |
|---|---|
| `list_my_workspaces` | The workspaces this account can act in, each with its uuid. Resolve a client/brand name to the uuid the other tools scope with. |
| `list_my_stores` | Stores with their fulfillment providers + connected sales channels. |
| `list_my_designs` | Generated design images (newest first). |
| `list_my_products` | Products with fulfillment + channel sync status (optionally per store). |
| `list_my_orders` | Recent orders across channels. |
| `get_order_details` | One order: line items, payment + fulfillment status, shipments. |

## Catalog

| Tool | Summary |
|---|---|
| `browse_catalog` | Browse a provider catalog (Printful/Printify) for garments. |
| `get_garment_details` | Variant matrix, print templates, pricing floor, quality tier. Surfaces the BC 3001 AQUA-vs-Navy variant warning. |
| `recommend_garment` | Knowledge-based garment pick + rationale + alternatives (BC 3001 vs Comfort Colors, budget vs premium). |

## Design

| Tool | Summary |
|---|---|
| `design_apparel` | **Atomic.** Generate a design with the rules baked in (solid-green background prompt, transparency keying, optional text check). Streams progress. |
| `iterate_design` | img2img variation of an existing design (Nano Banana / OpenAI only). |
| `generate_image` | *(split)* Generate the raw image; handles the async slow-model poll. |
| `process_transparency` | *(split)* Key the background to true RGBA + upload (server-side Python/Pillow). Auto-recovers in green-dominance mode when the model produced a tinted/muted green instead of pure #00FF00; `background_mode` (`auto`/`box`/`dominance`) + `force` pin the strategy. |
| `verify_design_text` | *(split)* Read text via local OCR (tesseract) so the agent can confirm spelling. Advisory. |

## Product

| Tool | Summary |
|---|---|
| `ship_product` | **Atomic.** Design → mockup → create → variants → associate → sync (fulfillment then channels, draft). Enforces pricing floors + variant guards. Streams progress. |
| `update_product` | Update name/description/price. |
| `delete_product` | Hard delete (default) or archive. |
| `create_product` | *(split)* Create the product shell with correct field names + pricing floor. |
| `add_variants` | *(split)* Resolve + add variants; warns on the AQUA-vs-Navy trap. |
| `sync_to_fulfillment` | *(split)* Sync to Printful/Printify (do this before channels). |
| `sync_to_channel` | *(split)* Sync to one sales channel. Draft by default. |

## Systems of action

Mutating tools **default to a dry run**; applying only takes safe actions.

| Tool | Summary |
|---|---|
| `analyze_what_works` | Own-account insights: best seller, top channel, average order value. Read-only. |
| `auto_optimize_listings` | Flag no-sales products to pause; applies as archive (never delete). |
| `cascade_price_change` | Change price once; cascades to variants and (with a store) re-syncs channels. |
| `recover_from_outage` | Diagnose failed fulfillment/channel syncs and retry them when applied. |

## Safety

| Tool | Summary |
|---|---|
| `verify_design_quality` | Local QC gate: alpha channel, clean corners, white pre-multiply, resolution, detected text → 0-100 score + issues. Needs local Python/Pillow. |
| `check_design_compliance` | Advisory trademark / prohibited-content text heuristic with a clear "not legal advice" disclaimer. |

## Orders

| Tool | Summary |
|---|---|
| `approve_order` / `unapprove_order` | Approve an order for fulfillment, or reverse that. |
| `hold_order` | Put an order on hold (optional reason). |
| `cancel_order` | Cancel an order (also cancels the provider draft where possible). Destructive. |
| `confirm_order` | Confirm a submitted draft to production (confirm-mode stores). |
| `submit_order_to_fulfillment` | Submit an order to the fulfillment provider as a draft. |
| `check_order_status` | Poll the provider + reconcile holds/tracking for one order. |
| `reconcile_order` | Pull payment/refund/cancellation from the sales channel and push tracking to it. Returns `{reconcilable, changes, ...}`. |
| `list_order_holds` | List an order's holds (e.g. design-approval). |
| `approve_order_hold` | Approve one hold. May return `deferred` when the provider can't flip it (with a dashboard link). |
| `request_hold_changes` | Request changes on a hold (`change_kind` minor/full_replacement + notes). |

## Analytics

Read-only. Filters: `start`, `end`, `store`, `currency`, `workspace`.

| Tool | Summary |
|---|---|
| `analytics_summary` | Headline KPIs + prior-period deltas. |
| `analytics_timeseries` | Revenue/orders over time (`interval` day/week/month). |
| `analytics_breakdown` | Breakdown by `dimension` (product_type, product, variant, sales_channel, fulfillment_provider, hold_reason). |
| `analytics_ops` | Velocity + hold/cancel/refund rates. |
| `analytics_portfolio` | Per-client KPIs across workspaces (agency plans; 403 otherwise). |

## Collections

| Tool | Summary |
|---|---|
| `list_collections` / `get_collection` | List a store's collections, or one with its products. |
| `create_collection` / `update_collection` / `delete_collection` | Manage a collection (name + description). |
| `add_products_to_collection` / `remove_product_from_collection` | Add/remove products. |
| `sync_collection` | Sync a collection to a connected sales channel (`integration_uuid`). |

## Cross-workspace transfer

For agency accounts moving assets between client workspaces. Resolve the destination uuid with `list_my_workspaces`; pass `source_workspace` if the asset isn't in your Default workspace.

| Tool | Summary |
|---|---|
| `copy_product_to_workspace` | Non-destructive draft duplicate into another workspace. |
| `move_product_to_workspace` | Re-stamp a product's workspace (409 if store-mapped or has orders → copy instead). |
| `check_product_move` | Dry-run eligibility: `{eligible, blockers}`. |
| `copy_design_to_workspace` / `move_design_to_workspace` / `check_design_move` | Same for generated designs. |

## Store & order management

| Tool | Summary |
|---|---|
| `get_store_settings` / `update_store_settings` | Fulfillment workflow (auto/confirm/review, approval authority, hold thresholds, notifications). |
| `create_store` / `archive_store` / `unarchive_store` / `activate_store` | Store lifecycle (new stores start closed → `activate_store`). |
| `record_order_payment` / `mark_order_no_payment` / `set_order_payment_method` | Record a payment on a manual order, or its method. |
| `sync_orders` / `estimate_order_costs` / `get_orders_summary` / `list_pending_fulfillments` | Pull orders from channels; estimate costs; dashboard summary; pending queue. |
| `archive_product` / `restore_product` | Archive a product (409 if it has pending orders) or restore it. |

## API escape hatch

| Tool | Summary |
|---|---|
| `get_api_reference` | Compact index of the live agent OpenAPI spec (path, methods, summary). Optional `filter` substring. Use to discover endpoints no dedicated tool covers. |
| `api_request` | Authenticated request to any `/agents/v1` endpoint (`method`, relative `path`, `query?`, `body?`, `workspace?`). Path-guarded (no host escape, no `..`); scoped to the account's own permissions. Prefer a dedicated tool when one exists. |

## Conventions

- **Auth** is connection-level (`APPARELHUB_API_KEY`); never a tool argument.
- **Workspaces**: agency accounts pass `workspace` (a uuid) to scope reads/writes; omit for the
  Default workspace.
- **`view_url`** appears on product/order/store results — a link back into apparelhub.ai.
- **Errors** are structured: `{error: {code, message, retry_after?, suggestion?}}`. Codes are
  broad on purpose (retry vs. surface-to-user); see the error contract in the source.
- **Progress**: long tools (`design_apparel`, `ship_product`, `generate_image`, mockups) stream
  MCP progress notifications.
