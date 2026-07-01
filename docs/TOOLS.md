# Tool reference

The full tool surface (v1). Call `tools/list` from your agent for the live JSON schemas; this is
the human-readable summary. Read tools are read-only; mutating tools default to safe behavior
(draft not live, dry-run, pricing floors) as noted.

## Read

| Tool | Summary |
|---|---|
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
| `process_transparency` | *(split)* Key the background to true RGBA + upload. Needs local Python/Pillow. |
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

## Conventions

- **Auth** is connection-level (`APPARELHUB_API_KEY`); never a tool argument.
- **Workspaces**: agency accounts pass `workspace` (a uuid) to scope reads/writes; omit for the
  Default workspace.
- **`view_url`** appears on product/order/store results — a link back into apparelhub.ai.
- **Errors** are structured: `{error: {code, message, retry_after?, suggestion?}}`. Codes are
  broad on purpose (retry vs. surface-to-user); see the error contract in the source.
- **Progress**: long tools (`design_apparel`, `ship_product`, `generate_image`, mockups) stream
  MCP progress notifications.
