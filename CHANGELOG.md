# Changelog

All notable changes to `@apparelhub/mcp-server` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The agent-facing **tool-surface** contract is versioned separately from the package (spec §10):
this package implements tool surface **v1**.

## [Unreleased]

## [0.4.0] - 2026-07-11

### Changed (major)

**Composition + placement now run on the platform.** `ship_product` / `create_product` send the
design + garment ref + print style to the platform's print-data preparation service and receive the
fully-composed per-placement `print_data` (Garment Intelligence epic apparelhub-ai#549 Phase 3 +
mcp#101). The client no longer holds the per-garment layout knowledge — so new placement
calibrations reach every client as a platform data update, with no npm release.

- **Removed** the bundled per-garment layout table + the local composition pipeline
  (`knowledge/garments.ts` face layouts, the layout resolver, `image/dimensions.ts`, the Python
  `recompose_fill.py`, and the `recomposeFill`/`solidFill` imaging methods). The resolution floor
  (`ensure_resolution.py`) and chroma keying (`make_transparent`) stay client-side.
- **Embroidery thread-color derivation stays client-side** (attached to the create payload as
  before; the mockup stays options-free).
- **Tool surface is byte-identical** — no schema/description changes, no Always-allow resets for
  connector users.
- **Source maps are no longer published** with the package.

### Migration

- `npx @apparelhub/mcp-server` now **requires** the platform print-data service (it is part of the
  standard agent API your key already uses). Older 0.3.x releases keep composing locally with their
  bundled tables — they just don't receive new placement improvements.

## [0.3.14] - 2026-07-10

### Changed

**The hosted server now resolves garment print-geometry from the platform at runtime** (Garment
Intelligence epic, apparelhub-ai#549 Phase 2b). When `MCP_SERVICE_KEY` is configured (the hosted
deployment only), product composition resolves per-garment **face layouts + print-style routing +
interior-surface blanking** from the platform's `garment_layouts` store instead of the bundled
`knowledge/garments.ts` tables. New calibrations reach the hosted server the moment they land as DB
rows — no npm release, no version skew across surfaces.

- Local `npx` usage is **unchanged**: with no service key it always uses the bundled tables.
- Graceful degradation: any resolve failure (endpoint unavailable, non-200, malformed body) falls
  back to the bundled tables, so composition never breaks. Resolved layouts are cached per
  `(provider, product_ref)` for the process lifetime.
- **Tool surface is byte-identical** — schemas and descriptions are unchanged; this is a pure
  internal-resolution swap.

## [0.3.13] - 2026-07-10

### Fixed

Four more "print area != visible FACE" garment quirks, found by the proactive **Merch QC discovery
sweep** (rendering a standardized QC probe on diverse garments and grading each by vision) and each
grid-calibrated + live-verified clip-free. `faceLayoutFor` (knowledge/garments.ts) gains a branch
per garment:

- **Tote bags (Printful 274) top-favor the visible front.** The single `default` wrap area is the
  front + back folded at the bottom, so a subject centered on the area is clipped at the fold. Art
  now composes into the top ~45%; the pocket sibling gets the solid background.
- **Softcover journals / notebooks (Printful 1013) print on the FRONT cover, clear of the spine.**
  The `outside_cover` area is back + spine + front laid flat, so a centered design lands ON the
  spine and is cut by the crease. Art now composes onto the right half (the front cover).
- **Bucket hats (Printful 654) confine the design to the flat front crown.** The `outside_front`
  area is a tightly-curved dome — a full-bleed design wraps over the crown top and down the brim.
  Art now sits in the small flat front-facing band.
- **Mugs / steins get a TIGHTER front-arc inset than a tall bottle.** A mug's front-facing arc is
  only the central ~50% of the print width (horizontal-stripe-probe calibrated), so the general
  cylinder inset (tuned for a tall water bottle) let a centered design wrap around the mug's sides
  out of view. `MUG_RE` is checked before `CYLINDER_RE` and insets to the front arc.

### Changed

- **Interior / label surfaces on fill goods now print BLANK, never solid-filled.** `fetchGarment`
  drops `inside_*`, `page*`, and `label_*` placements from the fill set (new `isInteriorPlacement`),
  so a journal's inside cover + pages and a reversible bucket hat's inside faces are left unprinted
  instead of getting inked with the design's background color. Exterior display/structural
  placements (front/back/top/bottom/pocket, `outside_*`) are unaffected — "outside" never matches
  "inside".

Tool surface unchanged (internal fill-geometry knowledge only). No schema/description changes.

## [0.3.12] - 2026-07-10

### Added

- **`list_my_products` now returns `created` and `updated` per product.** The underlying list
  endpoint already provides them; the tool was dropping them. Exposing the timestamps lets a caller
  reason about recency — e.g. a reconciler/scheduled job deciding whether the product set has been
  stable long enough to self-terminate (nothing built or rebuilt within a grace window). Without
  this a stable-completion self-delete couldn't verify its condition and had to stay running.

## [0.3.11] - 2026-07-09

### Fixed

- **Backpack designs favor the top half so a subject isn't split by the pocket seam** (the SPAIN
  backpack: the goalkeeper's body and "La Roja" straddled the front-pocket seam). A Printful 279
  All-Over Print Backpack has a front pocket whose seam runs across the lower ~40% of the front
  face — a design filling the front area is cut in half by it. `faceLayoutFor` now composes the
  backpack design into the upper-body window ABOVE the seam; the background fills the rest of the
  front and the pocket/top/bottom panels stay solid, so lettering and player bodies stay intact.
  Grid-calibrated + live-verified: the full SPAIN crest sits in the upper body, nothing split.
  (Abstract all-over patterns that read fine when split can still be printed full-bleed.)

## [0.3.10] - 2026-07-09

### Fixed

- **Designs no longer clip at the top/bottom/sides of cylindrical drinkware** (the MOROCCO water
  bottle: the flag star clipped at the top, "MOROCCO" clipped at the base). A water bottle / tumbler
  / mug / glass print area WRAPS AROUND the tube — its top maps onto the shoulder/neck, its bottom
  onto the base, and its left/right around the sides out of frontal view — so a design that fills
  the area gets cut at every edge. `faceLayoutFor` now recognizes cylindrical drinkware and insets
  the art into the flat frontal band with margin, so nothing touches a wrapping edge (grid-calibrated
  + live-verified clip-free on the Slim Water Bottle). Same "print area != visible face" family as
  the duffle and headphone ear cups.

## [0.3.9] - 2026-07-09

### Fixed

- **Low-resolution QC block no longer strands an unattended run** (the NORWAY passport wallet, which
  an hourly scheduled task skipped every run and could never finish). Two changes so a low-res
  design AUTO-RECOVERS instead of dead-ending at the pre-flight QC gate:
  - `process_transparency` now upscales its keyed result back to a resolution floor (2000px long
    side, Lanczos, white-premultiplied). Keying + tight-crop can shrink a 1024×1024 design to
    847×396 (min side < 600 = the QC gate's hard block); it now emerges print-ready, so a caller
    that gates on `verify_design_quality` before building passes instead of skipping.
  - `verify_design_quality` now treats low resolution as a **warn, never a hard block** — the build
    pipeline upscales low-res designs to the print area (process_transparency here, ship_product's
    placed-path resolution net downstream), so a low-res design must not make an unattended run skip
    the item. The warn still surfaces it (regenerate the source for genuine large-format detail) and
    the score stays ≥70 so the item builds.

## [0.3.8] - 2026-07-09

### Fixed

- **Lettering never clipped at a face edge** (the BELGIUM headphones cut the "S" in SPAIN at the
  oval edge). The headphone ear-cup art is now inset well inside the oval's safe area (56% width,
  centered), so no lettering touches an edge; both cups still print. General rule for oval / irregular
  faces: the composed art must sit fully within the printable silhouette with margin, never bled to
  the edge.
- **No white strip / no full-bleed-everywhere on duffles** (the NORWAY duffle). The fill sibling
  logic now distinguishes DISPLAY faces from STRUCTURAL panels by whether a placement has its own
  face layout: display faces (sock leg strips, both headphone cups) get the composed art; structural
  panels (duffle sides/top/bottom/pocket, backpack top/bottom/pocket) get the SOLID background — never
  the design plastered full-bleed (the previous same-size-sibling behavior would have stamped the
  duffle's design onto every panel and clipped it) and never left blank/white. A duffle now prints as
  a hero design on the front window with clean solid wrap panels, fully covered on every face.

## [0.3.7] - 2026-07-09

### Fixed

- **No blank faces on multi-face / multi-piece merch** (the WC26 headphones + wallet + duffle
  incidents), all grid-calibrated against the live providers:
  - **Zipper / passport wallets** (Printify 708, ~2482x2756): the near-square print area is BOTH
    exterior faces folded at the bottom — a centered design split across the spine. Fill/placed now
    composes the design onto BOTH faces (front = top half upright, back = bottom half composed
    rotated 180deg so it reads upright past the fold). `faceLayoutFor` returns MULTIPLE face rects;
    `recompose_fill.py --face` is now REPEATABLE with an optional per-face `:1` rotate flag.
  - **Headphone ear-cup shells** (Printify 1666, AirPods Max): each cup is a separate oval face
    (Left + Right). The design printed on ONE cup only. It now composes inset to the oval safe area
    and prints on BOTH cups; a `replicatePlacedAcrossPieces` helper also covers any other placed
    non-apparel multi-piece good so no piece ships blank.
  - **All-over duffles** (Printful 465): the front/back display areas wrap past the seams and
    rounded ends, so a full-width design clipped its edges and left the far side / a white strip
    bare. The design now composes into the central frontal window and the sides/top/bottom/pocket
    get the shared solid background (no unprinted face).
- **Resolution safety net — the missing "regenerate at higher resolution" step** (the WC26 NORWAY
  passport-wallet QC block). A design generated at ~1024px, keyed and auto-cropped to its artwork
  bbox, can shrink to e.g. 847x596; placed on a large print area the fulfillment platform's QC gate
  BLOCKS it ("low resolution") with no automatic remediation, dead-ending the build. The PLACED
  path now upscales the design (Lanczos, white-premultiplied) to the print area's resolution (new
  `ensure_resolution.py`, floor clamped to [2000, 3000]px) so it clears the gate; fill/face
  composition already produced a high-pixel canvas. A `warnings[]` note recommends regenerating for
  genuine large-format detail. Products carry a `placements_covered` list in the result.

### Changed

- `FaceLayout` now models `faces: FaceRect[]` (one rect per physical face, each optionally
  `rotate180`) instead of a single `face` + top-level `rotate180`. `recompose_fill.py` gains a
  `--transparent` mode (per-face composition preserving transparency for placed wrap goods) and
  repeatable `--face X:Y:W:H[:R]`.

## [0.3.6] - 2026-07-09

### Fixed

- **Fill printing now knows the print area is not always the visible FACE** (the WC26
  ENGLAND sock + drawstring incidents). Two wrap-style templates are face-calibrated (grid-file
  preview renders against the live providers):
  - **Printful sock leg placements**: the FRONT strips render the file **rotated 180°** (file-top
    = toe) while the BACK strips render it upright (file-top = cuff), and the strip wraps the leg
    tube so art at ~86% width clipped at the silhouette. Fill now composes a rotated file for the
    fronts and an upright file for the backs, both confined to the central frontal band.
  - **Drawstring-bag wrap areas** (Printify blueprint 414: 4950x11100 ~= 16.5"x37") are the front +
    back folded at the bottom — centered art straddled the fold and printed cut off at the hem.
    Fill now composes the art into the visible front (top band, clear of the drawstring channel
    and grommet corners) while the background still fills the whole area (solid back).
  - Unknown fill areas with an extreme aspect (<=1:2 / >=2.2:1) surface a **warning** to inspect
    the mockup for wrap/fold cropping instead of silently center-composing.
- **Fill goods now put a file on EVERY print placement, not just the chosen one.** The ENGLAND
  sock printed 1 of its 4 leg strips (the other sock + both backs shipped as raw white fabric);
  the SPAIN backpack's top/bottom/pocket placements were never printed (white bands). Same-size
  sibling placements reuse the composed art file; differing siblings get ONE shared solid canvas
  in the art's background color (`recompose_fill.py --solid`). Mockup previews cover the same
  placement set.
- **Single-dimension variant matching** (the MOROCCO clear-phone-case failure): garments whose
  catalog has NO color dimension (clear cases: device sizes only) or NO size dimension resolve by
  the dimension they DO have instead of failing the whole build with "No variants could be
  resolved"; the requested name is kept as the variant label and a warning explains the match. The
  zero-resolved error now also lists the catalog's actual color/size names so an unattended agent
  can self-correct on the next call.

## [0.3.5] - 2026-07-09

### Fixed

- Thread-colors option id for plain `embroidery_front` placements (bare `thread_colors`), and an
  error-driven sync self-heal that rewrites the option id Printful names in its rejection. (See
  release notes for #84.)

## [0.3.4] - 2026-07-09

### Fixed

- Embroidery placements resolved from per-variant templates + thread colors attached at create;
  fill-face printing (`print_style`) introduced for face goods. (See release notes for #83.)

## [0.3.3] - 2026-07-09

### Fixed

- **Mockups didn't cover every color being imported.** `ship_product` generated the mockup from the
  first 5 resolved variants — which for a multi-color order (e.g. Black + White) are all ONE color
  (Black's sizes come first), so the White variants shipped with no mockup and the product gallery
  only showed black. Mockups are now generated for **one representative variant per DISTINCT color**
  (new `mockupIdsCoveringColors` helper), so the generated set covers every color the product
  offers. `ship_product` "thinks ahead": it resolves your variants first, then renders one mockup
  per imported color. `create_product`'s auto-derived mockup now also samples one-per-color from the
  catalog (best-effort — it runs before variants exist, so for color-accurate mockups use
  `ship_product` or pass `mockup_variant_ids` for your chosen colors).

## [0.3.2] - 2026-07-09

### Fixed

- **Printify products came out with 0 variants** from `ship_product` / `create_product` / `add_variants`
  (and `ship_product` failed outright with "No valid variants found matching the selection"). Printify's
  variant matrix carries the variant id under **`provider_ref_id`** (a numeric string) with no
  `id`/`variant_id`/`provider_variant_id` field, but `mapMatrix` didn't read `provider_ref_id`, so every
  Printify variant resolved to id `0` and the platform rejected it. `mapMatrix` now includes
  `provider_ref_id` in the lookup (mirroring `catalog.ts`'s `get_garment_details` mapper, which was
  already correct — which is why that tool reported the right ids). Printful is unaffected (it has `id`,
  read first). So color+size variant selection now works for Printify without passing explicit
  `provider_variant_ids`.

## [0.3.1] - 2026-07-08

### Fixed

- **The split-primitive path could never place a product on a store.** `create_product` makes a
  STANDALONE product (on no store); the store association is `POST /store/<s>/products`, which
  only `ship_product` ever did. `sync_to_fulfillment` skipped it, and `sync_to_channel` assumed the
  product was already associated — so a caller that chained the primitives (notably an automated /
  scheduled agent) hit **"product not associated with store"** at the channel-sync step and the
  product was left created-but-unsynced. `sync_to_fulfillment` now associates the product with the
  store (idempotently) before the merchandise sync, so it truly is "the required step before
  sync_to_channel."
- **`create_product` silently ignored `generate_mockup: true`** unless `mockup_variant_ids` was
  also passed — but in the split-primitive flow variants are added AFTER create, so there were none
  to name, and the product shipped with the raw design as its display image (no garment mockup).
  `generate_mockup: true` now auto-derives representative variant ids from the garment catalog
  (already fetched for pricing), so it renders a real mockup on its own. Falls back to the raw
  design with an explicit `warnings[]` note only if no catalog variants are available.
- **`add_variants` silently created 0-variant products.** When no requested color/size combination
  resolved (the classic cause: assuming apparel sizes S/M/L/XL/2XL for a one-size garment like a
  cap/beanie/phone case — sizes are matched exactly), it returned `variants_added: 0` with a
  warning an automated caller would ignore. It now throws an actionable error listing the garment's
  actual available colors and sizes and pointing at `get_garment_details`.

### Changed

- **`sync_to_channel` now self-heals the missing prerequisite.** If the channel sync fails with a
  prerequisite-shaped client error (400/404/409/422 — the "not associated / not fulfillment-synced
  yet" case), the tool associates the product with the store, syncs it to the fulfillment provider,
  and retries the channel sync once, returning a `warnings[]` note that it did so. The clean,
  explicit order is still `sync_to_fulfillment` → `sync_to_channel` (which now pays nothing extra on
  the happy path); non-prerequisite errors (auth, rate limit, transient 5xx) still surface unchanged.
- **Clarified the ordering in tool descriptions** so an agent (including a fresh, memory-less
  scheduled run) can't miss it: `create_product` states it produces a standalone product and names
  the required next steps; `sync_to_channel` states its prerequisite and the auto-heal fallback;
  `sync_to_fulfillment` states it does the store association too; and `ship_product` recommends
  itself for automated / scheduled runs since it guarantees the correct order in one call.

## [0.3.0] - 2026-07-08

### Added

- **Fulfillment-issue tools** (platform epic apparelhub-ai#510): a post-sale problem-report group
  for defects on fulfilled orders — the item doesn't match the approved mockup, print quality,
  damaged in transit, wrong / missing item, late or lost. Printful/Printify accept problem
  reports **only in their own dashboards, within 30 days of delivery** (resolved as a free
  reprint or a wallet refund), so the tools compute the window, build the provider-ready report,
  and track the claim to resolution instead of pretending to file via API.
  - `report_fulfillment_issue` — open a tracked issue on an order (category, description,
    affected line items, requested resolution) with the report deadline + days remaining
    computed up front and a `next_step` pointing at the report/filing flow.
  - `list_fulfillment_issues` — one order's issues plus its report-window eligibility, or the
    workspace-wide issues inbox (`status` filter incl. `open_any` = open + filed upstream,
    `store` filter, limit/offset paging). Read-only.
  - `check_fulfillment_issue` — the full issue (items, evidence attachments, provider-claim
    tracking, resolution) plus, by default, the provider-ready problem report: a copy-paste
    `summary_text` and the provider dashboard deep-link.
  - `resolve_fulfillment_issue` — one dispatcher for the rest of the lifecycle:
    `submit_upstream` (record the provider filing + claim reference; returns the dashboard link),
    `resolve` (close with a `resolution_type`), and `create_replacement` (one-click zero-charge
    replacement/reship draft order built from the affected items). The platform's structured
    replacement refusals (`recipient_unavailable`, `variant_unlinked`, `replacement_exists`)
    surface honestly with what-to-do-instead guidance (create the order manually / reuse the
    existing replacement) rather than a generic conflict.
  - Evidence uploads are multipart and stay in the ApparelHub UI; the tools say so explicitly
    instead of failing opaquely. Tool surface grows 74 → 78.

## [0.2.7] - 2026-07-07

### Fixed

- **Image generation no longer fails for valid models due to a near-miss `source` name or a
  synchronous response** (#70). Two independent bugs meant an agent that called `generate_image` /
  `design_apparel` / `iterate_design` with a slightly-off model name — or with any synchronous
  model — could see a failure even though the platform generated and saved the image:
  - `source` is now validated + normalized (case-insensitively) to its canonical `VALID_SOURCES`
    name before the request is sent, so `"seedream 4.5"` / `"SeeDream 4.5"` resolve to
    `Seedream 4.5`. An unknown name (e.g. `"Flux 1.1"` instead of `Flux 1.1 Pro`) now raises a
    clear `bad_request` that lists the valid sources with a "did you mean …" hint, instead of a
    confusing downstream failure.
  - `runGeneration` now parses the platform's **synchronous** success response (image nested under
    `generated_image`), not just the async-poll shape. This fixes **OpenAI** and **Grok Imagine**
    (the synchronous models), which previously reported `generation_failed` on every successful
    generation.

### Removed

- The unused `ASYNC_SOURCES` / `isAsyncSource` export (dead code — `runGeneration` inspects the
  actual response — and it had drifted out of sync with the platform's slow-model set).

## [0.2.6] - 2026-07-07

### Changed

- **Honest structured error attribution (epic #66 phase 2).** Every failure now carries a cause an
  agent can attribute truthfully — an agent can no longer "diagnose" an ApparelHub rate limit that
  never happened (the motivating incident: a harness-side 429 got reported as "the ApparelHub
  image endpoint is rate-limited" while ApparelHub had received no request at all). The generic
  `rate_limited` code is split in two: **`model_rate_limited`** (a specific model's upstream
  provider throttled — carries `source` + `retry_after`; the fallback ladder handles it by
  switching models) vs **`platform_rate_limited`** (ApparelHub's own per-key request throttle —
  back off; switching models will not help, so it is deliberately NOT fallbackable and surfaces
  immediately). A fetch that never got a response is now **`request_not_sent`** (replacing
  `network_error`): a transport failure at or near the caller that must never be attributed to
  ApparelHub. The async poll path parses the platform's structured failure string
  (`model_rate_limited: {source} throttled by provider (retry_after={n}s)`) into the same precise
  code, so async models (Nano Banana — the default) trigger the ladder on the code instead of a
  message heuristic. `fallback_trail` entries now include the structured `code` per abandoned
  model, and when EVERY rung fails with `model_rate_limited` the final error keeps that code with
  back-off guidance. Server instructions + `generate_image`/`design_apparel` descriptions state
  the attribution rule; see the new `docs/error-attribution.md`.

## [0.2.5] - 2026-07-07

### Added

- **Model-fallback ladder for image generation (epic #67).** A genuine model/platform rate limit or
  a transient failure now transparently retries with a *different* model before surfacing an error,
  so one throttled provider no longer fails the whole run (an unattended agent got stuck because
  every generation defaulted to the same model). `generate_image`, `design_apparel`, and
  `iterate_design` walk a short ladder of fast fallbacks on *different* providers — default
  `Nano Banana → Flux 1.1 Pro → OpenAI` (abstract art leads with OpenAI; edits stay on the two
  edit-capable models `Nano Banana → OpenAI`) — so a per-provider limit is escaped cheaply. Any
  substitution is reported in a new `fallback_trail` (empty when the first model worked;
  per-design for `design_apparel`). Only rate-limit/transient failures fall back
  (`rate_limited`, `upstream_unavailable`, `network_error`, `generation_timeout`, and a
  rate-limit-shaped `generation_failed`); validation, auth, forbidden, and not_found surface
  immediately. An explicit `source` still falls back by default (a produced design beats none, and
  the switch is visible in `fallback_trail`); the new `no_fallback` input disables it so a pinned
  source fails on that source alone.

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

