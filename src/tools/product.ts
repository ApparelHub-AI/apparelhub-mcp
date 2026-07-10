import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
import { asArray, isRecord, num, str, viewUrl } from '../util/shape.js';
import { pickDimensions } from '../image/dimensions.js';
import {
  extremeAspectWarning,
  faceLayoutFor,
  isInteriorPlacement,
  placedStyleFor,
  pricingFloor,
  printStyleFor,
  type FaceLayout,
  type PrintStyle,
} from '../knowledge/garments.js';
import {
  expectedThreadColorsIdFromError,
  isEmbroideryPlacement,
  normalizeThreadColors,
  threadColorsOptionId,
} from '../knowledge/embroidery.js';
import { resolveVariants, type MatrixVariant } from '../knowledge/variants.js';
import { runMockup } from '../image/mockup.js';
import { resolveImageUrl } from './design.js';
import type { ToolContext } from './context.js';

// Product workflows (tool spec §3 + §3.5). ship_product runs the full 7-phase pipeline with the
// scar-tissue baked in:
//   - Lesson 2: the create endpoint uses provider_uuid / product_ref_id / price / print_data,
//     which DIFFER from the mockup endpoint's field names (image/mockup.ts handles that side).
//   - Lesson 53: two-phase mockup poll (in runMockup).
//   - Variants BEFORE sync; fulfillment sync BEFORE ecommerce sync; DRAFT (never live) default.
//   - Pricing floors: refuse to create at a negative-margin price.
//   - Lesson 7: AQUA-vs-Navy variant guard (in resolveVariants).

const enc = encodeURIComponent;

interface PrintPlacement {
  provider_ref_id: string;
  area_width: number;
  area_height: number;
}

interface GarmentInfo {
  matrix: MatrixVariant[];
  area: { area_width: number; area_height: number; provider_ref_id: string };
  /** EVERY non-embroidery print placement (primary first, deduped). Fill-style goods must put
   *  a file on all of them — an unprinted placement on an all-over product is raw white fabric
   *  (the ENGLAND sock: 1 of 4 leg placements printed; the SPAIN backpack: top/bottom/pocket). */
  placements: PrintPlacement[];
  baseCost: number | undefined;
  /** The chosen placement is an embroidery placement (caps/beanies/embroidered apparel). */
  isEmbroidery: boolean;
  name: string | undefined;
}

function mapMatrix(raw: unknown): MatrixVariant[] {
  return asArray(raw).map((v) => ({
    // Printify puts the variant id under `provider_ref_id` (a numeric string) with NO
    // id/variant_id/provider_variant_id field — so it must be in this lookup or every Printify
    // variant resolves to 0 and the platform rejects it ("No valid variants found matching the
    // selection"). Mirrors catalog.ts's mapVariant (get_garment_details). Printful is unaffected
    // (it has `id`, read first). num() coerces the numeric string.
    provider_variant_id: num(v, 'id', 'variant_id', 'provider_variant_id', 'provider_ref_id') ?? 0,
    color: str(v, 'color', 'color_name'),
    size: str(v, 'size'),
    cost: num(v, 'cost', 'price'),
  }));
}

/**
 * One representative provider_variant_id per DISTINCT color (in order, up to `cap`). Mockups are
 * rendered per variant, and variants of the same color share the same print image — so passing
 * "the first N variants" yields N shades of ONE color and leaves the other colors you're offering
 * with NO mockup. Passing one-per-color makes the generated mockup set COVER every color imported,
 * so the product's gallery has a mockup for each variant color (not just the first).
 */
function mockupIdsCoveringColors(
  variants: { color?: string; provider_variant_id: number }[],
  cap = 5,
): number[] {
  const seen = new Set<string>();
  const ids: number[] = [];
  for (const v of variants) {
    const id = v.provider_variant_id;
    const color = (v.color ?? '').toLowerCase().trim();
    if (typeof id === 'number' && id > 0 && !seen.has(color)) {
      seen.add(color);
      ids.push(id);
      if (ids.length >= cap) break;
    }
  }
  return ids;
}

/**
 * A template's placement name. Variant templates carry it under `provider_location_ref_id` and a
 * NUMERIC template id under `provider_ref_id` (which str() would coerce to "257169"), so
 * provider_location_ref_id MUST be read before provider_ref_id. Mirrors catalog.ts's mapTemplate.
 */
function templatePlacement(tpl: unknown): string | undefined {
  return str(tpl, 'placement', 'provider_location_ref_id', 'provider_ref_id', 'type');
}

/**
 * Choose the template the print targets: the true print front first, then any non-embroidery
 * placement, then whatever exists — embroidery-only garments (caps/beanies) carry ONLY
 * `embroidery_*` templates, and for those the embroidery placement IS the correct target.
 */
function pickPrintTemplate(templates: unknown[]): unknown {
  return (
    templates.find((t) => /^(front|default)$/i.test(templatePlacement(t) ?? '')) ??
    templates.find((t) => {
      const p = templatePlacement(t);
      return Boolean(p) && !isEmbroideryPlacement(p);
    }) ??
    templates[0]
  );
}

async function fetchGarment(
  ctx: ToolContext,
  providerUuid: string,
  productRefId: string,
  workspace?: string,
): Promise<GarmentInfo> {
  const raw = await ctx.api.get(
    `merchandise/${enc(providerUuid)}/product/${enc(productRefId)}`,
    { workspace, signal: ctx.signal },
  );
  const g = isRecord(raw) && isRecord(raw.product) ? raw.product : raw;
  const matrix = mapMatrix(isRecord(g) ? g.variants : undefined);
  let templates = asArray(
    isRecord(g) ? (g.templates ?? g.print_templates ?? g.print_areas) : undefined,
  );
  if (!templates.length && isRecord(g)) {
    // The raw garment endpoint has NO top-level template keys for Printful — templates live
    // per-VARIANT. Falling straight through to the 'front' default is what shipped
    // embroidery-only garments (caps/beanies) as `front` PRINT files, which Printful rejects
    // ("File type front is not allowed") at BOTH mockup generation and fulfillment sync.
    const firstVariant = asArray(g.variants)[0];
    if (isRecord(firstVariant)) templates = asArray(firstVariant.templates);
  }
  const chosen = pickPrintTemplate(templates);
  const placement = templatePlacement(chosen) ?? 'front';
  const area = {
    area_width: num(chosen, 'area_width', 'print_area_width') ?? 1800,
    area_height: num(chosen, 'area_height', 'print_area_height') ?? 2400,
    provider_ref_id: placement,
  };
  // Every distinct non-embroidery, non-INTERIOR placement, primary first. Fill goods must cover all
  // EXTERIOR display/structural placements (backpack top/bottom/pocket, both sock legs), but must
  // NOT touch interior surfaces — notebook inside cover + pages, reversible-hat inside faces, care
  // labels. Those are dropped here so they print BLANK (default), not solid-filled with the design
  // background (which would ink every inside page of a journal). See isInteriorPlacement.
  const placements: PrintPlacement[] = [
    { provider_ref_id: placement, area_width: area.area_width, area_height: area.area_height },
  ];
  for (const t of templates) {
    const p = templatePlacement(t);
    const w = num(t, 'area_width', 'print_area_width');
    const h = num(t, 'area_height', 'print_area_height');
    if (!p || p === placement || isEmbroideryPlacement(p) || isInteriorPlacement(p) || !w || !h)
      continue;
    if (placements.some((existing) => existing.provider_ref_id === p)) continue;
    placements.push({ provider_ref_id: p, area_width: w, area_height: h });
  }
  const baseCost = num(g, 'base_cost', 'cost', 'price') ?? matrix.find((m) => m.cost)?.cost;
  return {
    matrix,
    area,
    placements,
    baseCost,
    isEmbroidery: isEmbroideryPlacement(placement),
    name: str(g, 'name', 'title'),
  };
}

function buildPrintData(
  area: GarmentInfo['area'],
  designUrl: string,
  style: 'chest_fill' | 'back_center' | 'all_over' = 'chest_fill',
): Record<string, unknown>[] {
  // chest_fill: a placed print sized for a square design on APPAREL (13% collar breathing room).
  // back_center: the same sizing CENTERED on the face — non-apparel placed goods (phone cases,
  // mugs): collar padding shoved the MOROCCO clear-case crest into the top third of the case.
  // all_over: the design (recomposed to the area's exact aspect) covers the face edge-to-edge.
  const dims = pickDimensions(1, 1, area.area_width, area.area_height, style);
  return [
    {
      provider_ref_id: area.provider_ref_id,
      area_width: area.area_width,
      area_height: area.area_height,
      width: dims.width,
      height: dims.height,
      top: dims.top,
      left: dims.left,
      image_url: designUrl,
    },
  ];
}

/**
 * Copy of print_data with the embroidery thread-colors option attached. Goes ONLY on the
 * product-create payload (the platform persists it into print_files and hoists it to the
 * sync-variant level at Printful sync — Lesson 61); mockup templates stay options-free.
 */
function withThreadColorOptions(
  printData: Record<string, unknown>[],
  placement: string,
  colors: string[],
): Record<string, unknown>[] {
  return printData.map((t) => ({
    ...t,
    options: [{ id: threadColorsOptionId(placement), value: colors }],
  }));
}

/** The face layout of the garment's primary print area, if any. */
function primaryFaceLayout(garment: GarmentInfo): FaceLayout | undefined {
  return faceLayoutFor(
    garment.name,
    garment.area.provider_ref_id,
    garment.area.area_width,
    garment.area.area_height,
  );
}

/**
 * "No blank faces" for PLACED prints on NON-APPAREL multi-piece goods (AirPods-Max shell
 * cases: Left + Right cups): replicate the placed entry to every same-size non-embroidery
 * sibling placement — one printed piece next to a bare one reads broken (the BELGIUM
 * headphones). Apparel is EXCLUDED (tee front/back share dims; auto-printing backs would be
 * wrong), and so is embroidery.
 */
function replicatePlacedAcrossPieces(
  printData: Record<string, unknown>[],
  garment: GarmentInfo,
): Record<string, unknown>[] {
  if (garment.isEmbroidery || placedStyleFor(garment.name) !== 'back_center') return printData;
  const primaryEntry = printData[0];
  if (!primaryEntry) return printData;
  const out = [...printData];
  for (const p of garment.placements) {
    if (p.provider_ref_id === garment.area.provider_ref_id) continue;
    if (p.area_width !== garment.area.area_width || p.area_height !== garment.area.area_height) {
      continue;
    }
    out.push({ ...primaryEntry, provider_ref_id: p.provider_ref_id });
  }
  return out;
}

/** The effective print style: embroidery is stitched art (never a full-bleed fill); an explicit
 *  choice wins; otherwise face goods default to 'fill', apparel to 'placed'. */
function resolvePrintStyle(
  requested: 'auto' | PrintStyle | undefined,
  garment: GarmentInfo,
): PrintStyle {
  if (garment.isEmbroidery) return 'placed';
  if (requested && requested !== 'auto') return requested;
  return printStyleFor(garment.name);
}

interface FillDesign {
  image_uuid: string;
  image_url: string;
  background?: string;
  mode: 'composited' | 'cover' | 'solid';
  /** print_data covering EVERY placement (art on the primary + same-size siblings, solid
   *  background on the rest) — an unprinted placement on an all-over product is raw fabric. */
  printData: Record<string, unknown>[];
  warnings: string[];
}

/** Upload a composed file as a new revision of the design; returns its uuid + public URL. */
async function uploadDesignRevision(
  ctx: ToolContext,
  parentUuid: string,
  path: string,
  name: string,
  workspace?: string,
): Promise<{ uuid?: string; url?: string }> {
  const bytes = await ctx.imaging.readBytes(path);
  const form = new FormData();
  form.append('image', new Blob([Uint8Array.from(bytes)], { type: 'image/png' }), name);
  const res = await ctx.api.post(`images/generated/${enc(parentUuid)}/transform`, {
    multipart: form,
    workspace,
    signal: ctx.signal,
  });
  return { uuid: str(res, 'image_uuid', 'uuid'), url: str(res, 'url', 'image_url') };
}

/**
 * Resolution safety net (the WC26 passport-wallet lesson): a design generated at ~1024px, keyed
 * and auto-cropped to its artwork bbox, can shrink to e.g. 847x596 — placed on a large print
 * area, the platform QC gate BLOCKS it ("low resolution") with no automatic remediation. Fill /
 * face composition already outputs a high-pixel canvas; the PLACED path passes the raw design
 * straight through, so upscale it here to the print area's resolution (capped) when it's below
 * the floor. Upscaling clears the gate (what every POD tool does); regenerate for real detail.
 * No-op + no upload when the design is already large enough.
 */
async function ensurePlacedResolution(
  ctx: ToolContext,
  designUuid: string,
  designUrl: string,
  area: GarmentInfo['area'],
  workspace?: string,
): Promise<{ image_uuid: string; image_url: string; upscaled: boolean }> {
  const floor = Math.min(3000, Math.max(2000, Math.round(Math.max(area.area_width, area.area_height))));
  const inPath = await ctx.imaging.downloadToTemp(designUrl);
  try {
    const res = await ctx.imaging.ensureResolution(inPath, floor);
    if (!res.upscaled) {
      return { image_uuid: designUuid, image_url: designUrl, upscaled: false };
    }
    const up = await uploadDesignRevision(ctx, designUuid, res.outputPath, 'hires.png', workspace);
    await ctx.imaging.cleanup([res.outputPath]);
    return {
      image_uuid: up.uuid ?? designUuid,
      image_url: up.url ?? designUrl,
      upscaled: true,
    };
  } finally {
    await ctx.imaging.cleanup([inPath]);
  }
}

function fillEntry(p: PrintPlacement, imageUrl: string): Record<string, unknown> {
  return {
    provider_ref_id: p.provider_ref_id,
    area_width: p.area_width,
    area_height: p.area_height,
    width: p.area_width,
    height: p.area_height,
    top: 0,
    left: 0,
    image_url: imageUrl,
  };
}

/**
 * Recompose the design to FILL the print face (key any leftover chroma green, center the art on
 * an aesthetically matching background at the area's exact aspect — or cover-crop a photo), then
 * upload it as a new design revision. Prevents the "green screen printed on the product" and
 * "white bands around a floating square" defects on canvases/backpacks/bags/etc.
 *
 * Face-aware and placement-complete (the WC26 sock/drawstring lesson):
 *  - the art composes INSIDE the visible-face rectangle of wrap-style areas (drawstring bags
 *    print front+back in one file folded at the bottom) and rotates 180deg where the template
 *    renders inverted (Printful sock legs) — see knowledge/garments.ts faceLayoutFor;
 *  - EVERY other placement gets a file too: same-size siblings (the other sock strips) reuse
 *    the art file, different-size siblings (backpack top/bottom/pocket) get a solid canvas in
 *    the same background color, so no surface prints as raw white fabric.
 */
async function prepareFillDesign(
  ctx: ToolContext,
  designUuid: string,
  designUrl: string,
  garment: GarmentInfo,
  workspace?: string,
  transparent = false,
): Promise<FillDesign> {
  const warnings: string[] = [];
  const primary = garment.area;
  const layout = faceLayoutFor(
    garment.name,
    primary.provider_ref_id,
    primary.area_width,
    primary.area_height,
  );
  if (!layout) {
    const warn = extremeAspectWarning(
      garment.name,
      primary.provider_ref_id,
      primary.area_width,
      primary.area_height,
    );
    if (warn) warnings.push(warn);
  }

  const inPath = await ctx.imaging.downloadToTemp(designUrl);
  const tempPaths = [inPath];
  try {
    const rc = await ctx.imaging.recomposeFill(inPath, primary.area_width, primary.area_height, {
      faces: layout?.faces,
      transparent,
    });
    tempPaths.push(rc.outputPath);
    const uploaded = await uploadDesignRevision(ctx, designUuid, rc.outputPath, 'fill.png', workspace);
    const primaryUuid = uploaded.uuid ?? designUuid;
    const primaryUrl = uploaded.url ?? designUrl;

    const printData: Record<string, unknown>[] = [
      fillEntry(
        { provider_ref_id: primary.provider_ref_id, area_width: primary.area_width, area_height: primary.area_height },
        primaryUrl,
      ),
    ];

    // Cover EVERY sibling placement, but distinguish DISPLAY faces from STRUCTURAL panels:
    //  - a sibling with its OWN faceLayout is a display face (sock's 4 leg strips, both
    //    headphone cups) → gets the composed art for that layout (shared per layout: sock
    //    FRONT strips render rotated, BACK strips upright, so they compose differently);
    //  - a sibling with NO layout is a structural/wrap panel (duffle sides/top/bottom/pocket,
    //    backpack top/bottom/pocket) → gets the SOLID background, NEVER the design full-bleed
    //    (which would plaster + clip it) and NEVER left blank/white.
    // This is what keeps a duffle's front the hero while its wrap panels stay a clean solid
    // (the "white strip / design-on-every-panel" duffle failure).
    const layoutKeyOf = (l: FaceLayout | undefined): string => JSON.stringify(l?.faces ?? null);
    const artByLayout = new Map<string, string>([[layoutKeyOf(layout), primaryUrl]]);
    // ONE solid canvas serves every structural panel — a solid color stretches to any area
    // aspect losslessly (the platform scales the file to each entry's width x height).
    let solidUrl: string | undefined;
    for (const p of garment.placements) {
      if (p.provider_ref_id === primary.provider_ref_id) continue;
      const siblingLayout = faceLayoutFor(garment.name, p.provider_ref_id, p.area_width, p.area_height);
      if (siblingLayout) {
        // Display face: composed art (reused across identical layouts).
        const key = layoutKeyOf(siblingLayout);
        let url = artByLayout.get(key);
        if (url === undefined) {
          const alt = await ctx.imaging.recomposeFill(inPath, p.area_width, p.area_height, {
            faces: siblingLayout.faces,
            transparent,
          });
          tempPaths.push(alt.outputPath);
          const up = await uploadDesignRevision(ctx, designUuid, alt.outputPath, 'fill-alt.png', workspace);
          if (!up.url) {
            warnings.push(
              `Could not upload the composed art for placement "${p.provider_ref_id}" — it will print unfilled.`,
            );
            continue;
          }
          url = up.url;
          artByLayout.set(key, url);
        }
        printData.push(fillEntry(p, url));
        continue;
      }
      // Structural panel.
      if (transparent) continue; // placed semantics: no background canvases on other surfaces
      if (solidUrl === undefined) {
        const solid = await ctx.imaging.solidFill(inPath, p.area_width, p.area_height, rc.background);
        tempPaths.push(solid.outputPath);
        const up = await uploadDesignRevision(ctx, designUuid, solid.outputPath, 'fill-bg.png', workspace);
        if (!up.url) {
          warnings.push(
            `Could not upload the background fill for placement "${p.provider_ref_id}" — it will print unfilled.`,
          );
          continue;
        }
        solidUrl = up.url;
      }
      printData.push(fillEntry(p, solidUrl));
    }

    return {
      image_uuid: primaryUuid,
      image_url: primaryUrl,
      background: rc.background,
      mode: rc.mode,
      printData,
      warnings,
    };
  } finally {
    await ctx.imaging.cleanup(tempPaths);
  }
}

/** Explicit thread colors validated against the palette, else derived from the design. */
async function resolveThreadColors(
  ctx: ToolContext,
  explicit: string[] | undefined,
  designUrl: string,
): Promise<string[]> {
  if (explicit?.length) return normalizeThreadColors(explicit);
  let inPath: string | undefined;
  try {
    inPath = await ctx.imaging.downloadToTemp(designUrl);
    const derived = await ctx.imaging.threadColors(inPath);
    return normalizeThreadColors(derived);
  } catch (err) {
    if (err instanceof AhError && err.code === 'local_tool_unavailable') {
      throw new AhError({
        code: 'local_tool_unavailable',
        message:
          'This is an EMBROIDERY garment: Printful requires thread colors from its fixed 15-color palette, and the local toolchain to derive them from the design (Python 3 + Pillow) is unavailable.',
        suggestion:
          'Pass thread_colors explicitly (e.g. ["#000000", "#FFCC00"]) using only palette colors, or install Python 3 + Pillow and retry.',
      });
    }
    throw err;
  } finally {
    if (inPath) await ctx.imaging.cleanup([inPath]);
  }
}

function enforcePricingFloor(baseCost: number | undefined, price: number): void {
  const floor = pricingFloor(baseCost);
  if (floor !== undefined && price < floor) {
    throw new AhError({
      code: 'pricing_floor',
      message: `Price $${price.toFixed(2)} is below the recommended minimum $${floor.toFixed(2)} for this garment (it would risk a negative margin).`,
      suggestion: `Set price >= $${floor.toFixed(2)}.`,
    });
  }
}

/**
 * Fulfillment (merchandise) sync with the embroidery thread-colors self-heal: when Printful
 * rejects the sync naming a DIFFERENT thread-colors option id than the one on the product
 * ("<expected_id> option is missing or incorrect! Allowed values: ..."), rewrite the product's
 * print_files option id to the expected one and retry ONCE. Printful's id convention varies by
 * placement (bare `thread_colors` for plain embroidery_front, suffixed elsewhere) and can vary by
 * product — the error message is the authoritative source. Any other failure propagates.
 */
async function syncFulfillmentHealingThreadColors(
  ctx: ToolContext,
  storeUuid: string,
  productUuid: string,
  workspace?: string,
): Promise<{ healedOptionId?: string }> {
  const syncOnce = () =>
    ctx.api.post(`store/${enc(storeUuid)}/products/${enc(productUuid)}/sync`, {
      query: { target: 'merchandise' },
      workspace,
      signal: ctx.signal,
    });
  try {
    await syncOnce();
    return {};
  } catch (err) {
    const message = err instanceof AhError ? err.message : String(err);
    const expected = expectedThreadColorsIdFromError(message);
    if (!expected) throw err;
    const prodRaw = await ctx.api.get(`product/${enc(productUuid)}`, {
      workspace,
      signal: ctx.signal,
    });
    const prod = isRecord(prodRaw) && isRecord(prodRaw.product) ? prodRaw.product : prodRaw;
    const printFiles = asArray(isRecord(prod) ? prod.print_files : undefined);
    let changed = false;
    const fixed = printFiles.map((pf) => {
      if (!isRecord(pf) || !Array.isArray(pf.options)) return pf;
      const options = pf.options.map((o) => {
        if (
          isRecord(o) &&
          typeof o.id === 'string' &&
          /^thread_colors/i.test(o.id) &&
          o.id.toLowerCase() !== expected
        ) {
          changed = true;
          return { ...o, id: expected };
        }
        return o;
      });
      return { ...pf, options };
    });
    // Nothing correctable (e.g. a pre-fix product with NO thread-colors options at all) — the
    // original error is the real story; let it surface.
    if (!changed) throw err;
    await ctx.api.patch(`product/${enc(productUuid)}`, {
      body: { print_files: fixed },
      workspace,
      signal: ctx.signal,
    });
    await syncOnce();
    return { healedOptionId: expected };
  }
}

/**
 * Idempotently (1) associate a product with a store and (2) sync it to the store's fulfillment
 * provider (Printful/Printify). This is the HARD prerequisite for any sales-channel sync: a
 * product created by create_product is standalone (on no store), and the ecommerce listing binds
 * to the fulfillment SKU. `POST store/<s>/products` is a no-op if the product is already
 * associated, and the merchandise sync is safe to repeat — so this is safe to call more than once.
 * Errors propagate: a caller that genuinely cannot associate / fulfillment-sync (e.g. the product
 * has no variants) must hear the real error, not get a cosmetic listing with no manufacturing path.
 */
async function associateAndSyncFulfillment(
  ctx: ToolContext,
  storeUuid: string,
  productUuid: string,
  workspace?: string,
): Promise<{ healedOptionId?: string }> {
  await ctx.api.post(`store/${enc(storeUuid)}/products`, {
    body: { product_uuids: [productUuid] },
    workspace,
    signal: ctx.signal,
  });
  return syncFulfillmentHealingThreadColors(ctx, storeUuid, productUuid, workspace);
}

// Client-error statuses where a sync_to_channel failure most likely means "the product isn't on
// the store / isn't fulfillment-synced yet" — worth a one-shot self-heal (associate + fulfillment
// sync) then retry. Auth (401/403), rate limit (429) and transient 5xx are NOT healable this way
// (the client already retried the transient ones), so those propagate unchanged.
const CHANNEL_SYNC_HEALABLE_STATUS = new Set([400, 404, 409, 422]);

const garmentSchema = z.object({
  provider_uuid: z.string().min(1),
  product_ref_id: z.string().min(1),
});
const variantSchema = z.object({
  color: z.string().min(1),
  sizes: z.array(z.string().min(1)).min(1),
  price: z.number().positive().optional(),
  provider_variant_ids: z.array(z.number()).optional(),
});

export const shipProduct = defineTool({
  name: 'ship_product',
  description:
    'End-to-end pipeline in ONE call: take a design, generate + verify a mockup (one per imported color, so every color variant has a matching mockup), create the product with the correct field names, add all variants, associate with a store, sync to fulfillment, then (optionally) sync to sales channels as DRAFT. Handles EMBROIDERY garments (caps/beanies/embroidered apparel) automatically: routes the design to the real embroidery placement and attaches Printful thread colors (derived from the design, or pass thread_colors). Face goods (canvas, posters, backpacks, bags, socks, towels, blankets, pillows, cases...) default to print_style "fill": the design is recomposed onto an aesthetically matching background and printed edge-to-edge, so no green-screen background or contrasting borders reach the product. Enforces pricing floors and guards the AQUA-vs-Navy variant trap. Streams progress. PREFER this over chaining create_product + add_variants + sync_to_fulfillment + sync_to_channel yourself — especially for AUTOMATED or SCHEDULED runs — because it guarantees the correct order (store association + fulfillment sync BEFORE any channel sync). Use the split primitives only when you deliberately need a partial/interactive flow.',
  inputSchema: z.object({
    design_uuid: z.string().min(1),
    garment: garmentSchema,
    variants: z.array(variantSchema).min(1),
    pricing: z.object({ price: z.number().positive(), shipping_price: z.number().optional() }),
    product_meta: z.object({ name: z.string().min(1), description: z.string() }),
    store_uuid: z.string().optional().describe('Omit to create a standalone (unassociated) product.'),
    sync_to_channels: z
      .array(z.object({ integration_uuid: z.string(), state: z.enum(['draft', 'live']).optional() }))
      .optional(),
    generate_mockup: z.boolean().optional().describe('Default true.'),
    print_style: z
      .enum(['auto', 'placed', 'fill'])
      .optional()
      .describe(
        'How the design sits on the print face. "fill": recompose onto a matching background and print edge-to-edge (default for face goods like canvas/backpacks/bags/socks/towels/blankets/pillows/cases). "placed": the design floats with transparency preserved (default for apparel and embroidery). "auto" (default) picks by garment.',
      ),
    thread_colors: z
      .array(z.string().regex(/^#[0-9A-Fa-f]{6}$/))
      .min(1)
      .max(6)
      .optional()
      .describe(
        'EMBROIDERY garments only: explicit Printful thread palette colors. Omit to auto-derive from the design (mapped to the fixed 15-color palette).',
      ),
    design_url: z.string().url().optional().describe('The design URL, if known (else resolved).'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const ws = input.workspace;
    const warnings: string[] = [];

    await ctx.progress.report(5, 'Resolving garment + variants...');
    const garment = await fetchGarment(ctx, input.garment.provider_uuid, input.garment.product_ref_id, ws);
    enforcePricingFloor(garment.baseCost, input.pricing.price);

    const resolvedR = resolveVariants(
      garment.matrix,
      input.variants.map((v) => ({
        color: v.color,
        sizes: v.sizes,
        provider_variant_ids: v.provider_variant_ids,
        price: v.price,
      })),
      input.garment.product_ref_id,
      input.pricing.price,
    );
    warnings.push(...resolvedR.warnings);
    if (!resolvedR.resolved.length) {
      // Name the catalog's ACTUAL values so an unattended agent can self-correct on the next
      // call instead of stalling (the MOROCCO phone-case run had to diagnose this blind).
      const colors = [...new Set(garment.matrix.map((m) => m.color).filter(Boolean))].slice(0, 8);
      const sizes = [...new Set(garment.matrix.map((m) => m.size).filter(Boolean))].slice(0, 12);
      throw new AhError({
        code: 'bad_request',
        message: 'No variants could be resolved for the requested colors/sizes.',
        suggestion:
          `This garment's catalog has ` +
          `${colors.length ? `colors: ${colors.join(', ')}` : 'NO color dimension'} and ` +
          `${sizes.length ? `sizes: ${sizes.join(', ')}${garment.matrix.length > 12 ? ', ...' : ''}` : 'NO size dimension'}. ` +
          'Match those names (see get_garment_details), or pass provider_variant_ids.',
      });
    }
    if (resolvedR.unresolved.length) {
      warnings.push(
        `Skipped ${resolvedR.unresolved.length} unresolved variant(s): ${resolvedR.unresolved
          .map((u) => `${u.color}/${u.size}`)
          .join(', ')}.`,
      );
    }
    let designUuid = input.design_uuid;
    let designUrl = input.design_url ?? (await resolveImageUrl(ctx, input.design_uuid, ws));

    const printStyle = resolvePrintStyle(input.print_style, garment);
    let fill: FillDesign | undefined;
    if (printStyle === 'fill') {
      await ctx.progress.report(12, 'Recomposing design to fill the print face...');
      fill = await prepareFillDesign(ctx, designUuid, designUrl, garment, ws);
    } else if (!garment.isEmbroidery && primaryFaceLayout(garment)) {
      // PLACED on a wrap-style area (zipper wallets; automated runs often pass print_style
      // explicitly): blind centering splits the art at the fold — compose it per-FACE on a
      // TRANSPARENT canvas instead, preserving placed semantics.
      await ctx.progress.report(12, 'Composing design onto each product face...');
      fill = await prepareFillDesign(ctx, designUuid, designUrl, garment, ws, true);
    }
    if (fill) {
      designUuid = fill.image_uuid;
      designUrl = fill.image_url;
      warnings.push(...fill.warnings);
    } else if (!garment.isEmbroidery) {
      // Placed path: guarantee the design meets the print area's resolution (the passport-wallet
      // low-res QC block). Composed fill/face files are already high-res; embroidery is skipped.
      const hi = await ensurePlacedResolution(ctx, designUuid, designUrl, garment.area, ws);
      designUuid = hi.image_uuid;
      designUrl = hi.image_url;
      if (hi.upscaled) {
        warnings.push('Design upscaled to meet the print-area resolution (regenerate at higher resolution for sharper large-format detail).');
      }
    }

    let threadColors: string[] | undefined;
    if (garment.isEmbroidery) {
      await ctx.progress.report(15, 'Resolving embroidery thread colors...');
      threadColors = await resolveThreadColors(ctx, input.thread_colors, designUrl);
    }

    const printData =
      fill?.printData ??
      replicatePlacedAcrossPieces(
        buildPrintData(garment.area, designUrl, placedStyleFor(garment.name)),
        garment,
      );

    let previewJobUuid: string | undefined;
    if (input.generate_mockup ?? true) {
      const m = await runMockup(
        ctx.api,
        {
          merchandise_provider_uuid: input.garment.provider_uuid,
          generated_image_uuid: designUuid,
          provider_product_ref_id: input.garment.product_ref_id,
          templates: printData,
          // Cover EVERY color being imported (one mockup per color), not the first 5 variants —
          // which are all one color and leave the other imported colors with no mockup.
          variant_ids: mockupIdsCoveringColors(resolvedR.resolved),
        },
        { progress: ctx.progress, signal: ctx.signal, workspace: ws },
      );
      previewJobUuid = m.job_uuid;
    }

    await ctx.progress.report(55, 'Creating product...');
    const created = await ctx.api.post('product/create', {
      body: {
        name: input.product_meta.name,
        description: input.product_meta.description,
        generated_image_uuid: designUuid,
        preview_job_uuid: previewJobUuid,
        provider_uuid: input.garment.provider_uuid,
        product_ref_id: String(input.garment.product_ref_id),
        price: input.pricing.price,
        print_data: threadColors
          ? withThreadColorOptions(printData, garment.area.provider_ref_id, threadColors)
          : printData,
      },
      workspace: ws,
      signal: ctx.signal,
    });
    const productUuid = str(created, 'uuid', 'product_uuid') ?? '';
    if (!productUuid) {
      throw new AhError({ code: 'internal_error', message: 'Product create did not return a uuid.' });
    }

    await ctx.progress.report(70, `Adding ${resolvedR.resolved.length} variants...`);
    let added = 0;
    for (const v of resolvedR.resolved) {
      await ctx.api.post(`product/${enc(productUuid)}/variants`, {
        body: {
          name: v.color,
          price: v.price ?? input.pricing.price,
          color: v.color,
          size: v.size,
          provider_variant_id: v.provider_variant_id,
        },
        workspace: ws,
        signal: ctx.signal,
      });
      added += 1;
    }

    let fulfillmentStatus: 'synced' | 'pending' | 'failed' = 'pending';
    const channelResults: Record<string, unknown>[] = [];
    if (input.store_uuid) {
      await ctx.api.post(`store/${enc(input.store_uuid)}/products`, {
        body: { product_uuids: [productUuid] },
        workspace: ws,
        signal: ctx.signal,
      });
      await ctx.progress.report(85, 'Syncing to fulfillment...');
      try {
        const healed = await syncFulfillmentHealingThreadColors(ctx, input.store_uuid, productUuid, ws);
        fulfillmentStatus = 'synced';
        if (healed.healedOptionId) {
          warnings.push(
            `The fulfillment provider expects thread-colors option id "${healed.healedOptionId}" for this garment — auto-corrected on the product and re-synced.`,
          );
        }
      } catch (err) {
        fulfillmentStatus = 'failed';
        warnings.push(`Fulfillment sync failed: ${err instanceof AhError ? err.message : String(err)}`);
      }

      // Only sync to sales channels AFTER fulfillment (lifecycle ordering).
      for (const ch of input.sync_to_channels ?? []) {
        const state = ch.state ?? 'draft';
        try {
          const r = await ctx.api.post(`store/${enc(input.store_uuid)}/products/${enc(productUuid)}/sync`, {
            query: { target: 'ecommerce', integration_uuid: ch.integration_uuid, listing_state: state },
            workspace: ws,
            signal: ctx.signal,
          });
          channelResults.push({
            integration_uuid: ch.integration_uuid,
            status: state === 'live' ? 'synced_as_live' : 'synced_as_draft',
            listing_url: str(r, 'listing_url', 'external_url', 'url'),
          });
        } catch (err) {
          channelResults.push({
            integration_uuid: ch.integration_uuid,
            status: 'failed',
            error: err instanceof AhError ? err.message : String(err),
          });
        }
      }
    }

    await ctx.progress.report(100, 'Done.');
    return {
      product_uuid: productUuid,
      product_url: viewUrl.product(productUuid),
      fulfillment_status: fulfillmentStatus,
      variants_added: added,
      channel_sync_results: channelResults,
      print_style: printStyle,
      placements_covered: printData.map((t) => t.provider_ref_id),
      ...(threadColors ? { thread_colors: threadColors } : {}),
      ...(fill?.background ? { fill_background: fill.background } : {}),
      warnings,
    };
  },
});

// --- Split primitives ---

export const createProduct = defineTool({
  name: 'create_product',
  description:
    'Create a STANDALONE product from a design (split primitive) — it is NOT placed on any store yet. Applies the correct field names + pricing floor, routes EMBROIDERY garments (caps/beanies) to their real embroidery placement with Printful thread colors (derived or explicit), and defaults face goods (canvas/backpacks/bags/socks/towels/blankets/pillows/cases...) to print_style "fill" (design recomposed onto a matching background, printed edge-to-edge). Set generate_mockup: true to render a garment mockup as the display image (it auto-derives representative variants from the catalog, so you do NOT need mockup_variant_ids) — otherwise the raw design is used as the display image. To get it onto a store and listed, the required sequence is: add_variants -> sync_to_fulfillment(product_uuid, store_uuid) [associates it with the store + syncs to Printful/Printify] -> sync_to_channel [sales channel]. To run that whole pipeline in one call instead, use ship_product.',
  inputSchema: z.object({
    design_uuid: z.string().min(1),
    garment: garmentSchema,
    pricing: z.object({ price: z.number().positive(), shipping_price: z.number().optional() }),
    product_meta: z.object({ name: z.string().min(1), description: z.string() }),
    generate_mockup: z.boolean().optional(),
    mockup_variant_ids: z.array(z.number()).optional().describe('Representative variant ids for the mockup preview.'),
    print_style: z
      .enum(['auto', 'placed', 'fill'])
      .optional()
      .describe(
        'How the design sits on the print face. "fill": recompose onto a matching background and print edge-to-edge (default for face goods). "placed": transparency preserved (default for apparel and embroidery). "auto" (default) picks by garment.',
      ),
    thread_colors: z
      .array(z.string().regex(/^#[0-9A-Fa-f]{6}$/))
      .min(1)
      .max(6)
      .optional()
      .describe(
        'EMBROIDERY garments only: explicit Printful thread palette colors. Omit to auto-derive from the design.',
      ),
    design_url: z.string().url().optional(),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const ws = input.workspace;
    const garment = await fetchGarment(ctx, input.garment.provider_uuid, input.garment.product_ref_id, ws);
    enforcePricingFloor(garment.baseCost, input.pricing.price);
    let designUuid = input.design_uuid;
    let designUrl = input.design_url ?? (await resolveImageUrl(ctx, input.design_uuid, ws));

    const warnings: string[] = [];
    const printStyle = resolvePrintStyle(input.print_style, garment);
    let fill: FillDesign | undefined;
    if (printStyle === 'fill') {
      fill = await prepareFillDesign(ctx, designUuid, designUrl, garment, ws);
    } else if (!garment.isEmbroidery && primaryFaceLayout(garment)) {
      fill = await prepareFillDesign(ctx, designUuid, designUrl, garment, ws, true);
    }
    if (fill) {
      designUuid = fill.image_uuid;
      designUrl = fill.image_url;
      warnings.push(...fill.warnings);
    } else if (!garment.isEmbroidery) {
      const hi = await ensurePlacedResolution(ctx, designUuid, designUrl, garment.area, ws);
      designUuid = hi.image_uuid;
      designUrl = hi.image_url;
      if (hi.upscaled) {
        warnings.push('Design upscaled to meet the print-area resolution (regenerate at higher resolution for sharper large-format detail).');
      }
    }

    let threadColors: string[] | undefined;
    if (garment.isEmbroidery) {
      threadColors = await resolveThreadColors(ctx, input.thread_colors, designUrl);
    }

    const printData =
      fill?.printData ??
      replicatePlacedAcrossPieces(
        buildPrintData(garment.area, designUrl, placedStyleFor(garment.name)),
        garment,
      );

    // Generate a mockup when asked. In the split-primitive flow, add_variants runs AFTER this, so
    // the product has no variants of its own yet — derive representative variant ids from the
    // garment catalog (fetched above) so `generate_mockup: true` actually produces a mockup instead
    // of silently leaving the raw design as the display image.
    const wantMockup = input.generate_mockup ?? Boolean(input.mockup_variant_ids?.length);
    let mockupVariantIds = input.mockup_variant_ids ?? [];
    if (wantMockup && mockupVariantIds.length === 0) {
      // Cover a RANGE of colors (one per color), not the first N variants (all one color).
      // Caveat: create_product runs before add_variants, so it can't know the exact colors you'll
      // import — for color-ACCURATE mockups use ship_product (it resolves your variants first and
      // renders one mockup per imported color), or pass mockup_variant_ids for your chosen colors.
      mockupVariantIds = mockupIdsCoveringColors(garment.matrix);
    }
    let previewJobUuid: string | undefined;
    let mockupStatus: 'generated' | 'skipped' = 'skipped';
    if (wantMockup && mockupVariantIds.length) {
      const m = await runMockup(
        ctx.api,
        {
          merchandise_provider_uuid: input.garment.provider_uuid,
          generated_image_uuid: designUuid,
          provider_product_ref_id: input.garment.product_ref_id,
          templates: printData,
          variant_ids: mockupVariantIds.slice(0, 5),
        },
        { progress: ctx.progress, signal: ctx.signal, workspace: ws },
      );
      previewJobUuid = m.job_uuid;
      mockupStatus = 'generated';
    } else if (wantMockup) {
      warnings.push(
        'generate_mockup was requested but no representative variant ids could be derived for this garment, so it will use the raw design as its display image. Pass mockup_variant_ids, or use ship_product (it resolves variants then generates the mockup).',
      );
    }

    const created = await ctx.api.post('product/create', {
      body: {
        name: input.product_meta.name,
        description: input.product_meta.description,
        generated_image_uuid: designUuid,
        preview_job_uuid: previewJobUuid,
        provider_uuid: input.garment.provider_uuid,
        product_ref_id: String(input.garment.product_ref_id),
        price: input.pricing.price,
        print_data: threadColors
          ? withThreadColorOptions(printData, garment.area.provider_ref_id, threadColors)
          : printData,
      },
      workspace: ws,
      signal: ctx.signal,
    });
    const productUuid = str(created, 'uuid', 'product_uuid') ?? '';
    return {
      product_uuid: productUuid,
      product_url: productUuid ? viewUrl.product(productUuid) : undefined,
      mockup_status: mockupStatus,
      print_style: printStyle,
      placements_covered: printData.map((t) => t.provider_ref_id),
      ...(threadColors ? { thread_colors: threadColors } : {}),
      ...(fill?.background ? { fill_background: fill.background } : {}),
      warnings,
    };
  },
});

export const addVariants = defineTool({
  name: 'add_variants',
  description:
    'Add variants to an existing product (split primitive). Resolves provider_variant_ids by color+size from the product\'s provider options (or pass them explicitly). Warns on the AQUA-vs-Navy trap. Variants must exist before syncing.',
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    variants: z.array(variantSchema).min(1),
    product_ref_id: z.string().optional().describe('Enables the AQUA-vs-Navy guard for BC 3001 ("71").'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const ws = input.workspace;
    const options = await ctx.api.get(`product/${enc(input.product_uuid)}/provider-options`, {
      workspace: ws,
      signal: ctx.signal,
    });
    const matrix = mapMatrix(
      Array.isArray(options)
        ? options
        : isRecord(options)
          ? (options.variants ?? options.options ?? options.provider_options)
          : undefined,
    );
    const resolvedR = resolveVariants(
      matrix,
      input.variants.map((v) => ({
        color: v.color,
        sizes: v.sizes,
        provider_variant_ids: v.provider_variant_ids,
        price: v.price,
      })),
      input.product_ref_id,
    );
    if (resolvedR.resolved.length === 0) {
      // Fail LOUDLY instead of silently creating a 0-variant product. The usual cause is assuming
      // apparel sizes (S/M/L/XL/2XL) for a garment that uses different labels — caps/beanies/phone
      // cases/bottles are often one-size. Sizes are matched exactly, so a mismatch resolves nothing.
      const colors = [...new Set(matrix.map((m) => m.color).filter((c): c is string => Boolean(c)))];
      const sizes = [...new Set(matrix.map((m) => m.size).filter((s): s is string => Boolean(s)))];
      throw new AhError({
        code: 'bad_request',
        message:
          'None of the requested color/size combinations exist for this garment, so no variants were added.',
        suggestion:
          `Available colors: [${colors.join(', ') || 'n/a'}]. Available sizes: [${sizes.join(', ') || 'n/a'}]. ` +
          'Do NOT assume S/M/L/XL/2XL — read the real options from get_garment_details and build the variant list from those (many accessories are one-size).',
      });
    }
    let added = 0;
    for (const v of resolvedR.resolved) {
      await ctx.api.post(`product/${enc(input.product_uuid)}/variants`, {
        body: { name: v.color, price: v.price, color: v.color, size: v.size, provider_variant_id: v.provider_variant_id },
        workspace: ws,
        signal: ctx.signal,
      });
      added += 1;
    }
    const warnings = [...resolvedR.warnings];
    if (resolvedR.unresolved.length) {
      warnings.push(
        `Unresolved: ${resolvedR.unresolved.map((u) => `${u.color}/${u.size}`).join(', ')}.`,
      );
    }
    return { product_uuid: input.product_uuid, variants_added: added, warnings };
  },
});

export const syncToFulfillment = defineTool({
  name: 'sync_to_fulfillment',
  description:
    "Associate a product with a store AND sync it to that store's fulfillment provider (Printful/Printify). This is the REQUIRED step before sync_to_channel: it both puts the product on the store (a product from create_product is standalone) and creates the manufacturing path the sales-channel listing binds to. Run it after the product has variants.",
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    store_uuid: z.string().min(1),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    // Associate with the store (idempotent) THEN sync to the fulfillment provider. The association
    // was previously missing here, so a product created by create_product (standalone) could not
    // be fulfillment-synced without a separate association call the split-primitive path never made.
    const healed = await associateAndSyncFulfillment(ctx, input.store_uuid, input.product_uuid, input.workspace);
    return {
      product_uuid: input.product_uuid,
      store_uuid: input.store_uuid,
      fulfillment_status: 'synced',
      ...(healed.healedOptionId
        ? {
            note: `The fulfillment provider expects thread-colors option id "${healed.healedOptionId}" for this garment — auto-corrected on the product and re-synced.`,
          }
        : {}),
    };
  },
});

export const syncToChannel = defineTool({
  name: 'sync_to_channel',
  description:
    'Sync one product to a sales channel (WooCommerce/Shopify/Wix) as a listing. PREREQUISITE: the product must first be associated with the store AND synced to its fulfillment provider — call sync_to_fulfillment(product_uuid, store_uuid) FIRST (it does the store association too). If that prerequisite is missing, this tool now AUTO-HEALS it (associate + fulfillment-sync, then retries once) instead of failing with "product not associated with store" — but the clean, explicit order is sync_to_fulfillment then sync_to_channel, and ship_product does the whole pipeline in one call. Defaults to DRAFT — only push live when the user explicitly asks.',
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    store_uuid: z.string().min(1),
    integration_uuid: z.string().min(1),
    state: z.enum(['draft', 'live']).optional(),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const state = input.state ?? 'draft';
    const ws = input.workspace;
    const warnings: string[] = [];

    const channelSync = () =>
      ctx.api.post(`store/${enc(input.store_uuid)}/products/${enc(input.product_uuid)}/sync`, {
        query: { target: 'ecommerce', integration_uuid: input.integration_uuid, listing_state: state },
        workspace: ws,
        signal: ctx.signal,
      });

    let r: unknown;
    try {
      r = await channelSync();
    } catch (err) {
      // Self-heal the most common first-attempt failure: the product was never associated with the
      // store / synced to fulfillment (a caller that jumped straight from create_product to here —
      // the exact bug this guards). Associate + fulfillment-sync idempotently, then retry ONCE.
      // Any non-prerequisite error (auth, rate limit, transient 5xx), or a still-failing retry, is
      // real — let it surface.
      if (
        !(err instanceof AhError) ||
        err.httpStatus === undefined ||
        !CHANNEL_SYNC_HEALABLE_STATUS.has(err.httpStatus)
      ) {
        throw err;
      }
      await associateAndSyncFulfillment(ctx, input.store_uuid, input.product_uuid, ws);
      warnings.push(
        'Product was not associated with the store / synced to fulfillment yet; auto-associated and synced to the fulfillment provider, then retried the channel sync. Call sync_to_fulfillment(product_uuid, store_uuid) before sync_to_channel to avoid this, or use ship_product for the whole pipeline in one call.',
      );
      r = await channelSync();
    }

    return {
      product_uuid: input.product_uuid,
      integration_uuid: input.integration_uuid,
      sync_status: state === 'live' ? 'synced_as_live' : 'synced_as_draft',
      channel_url: str(r, 'listing_url', 'external_url', 'url'),
      ...(warnings.length ? { warnings } : {}),
    };
  },
});

export const updateProduct = defineTool({
  name: 'update_product',
  description: 'Update a product (name, description, price). For a price change that must propagate to synced channels, prefer cascade_price_change.',
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    changes: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      price: z.number().positive().optional(),
    }),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {};
    if (input.changes.name !== undefined) body.name = input.changes.name;
    if (input.changes.description !== undefined) body.description = input.changes.description;
    if (input.changes.price !== undefined) body.price = input.changes.price;
    if (Object.keys(body).length === 0) {
      throw new AhError({ code: 'bad_request', message: 'No changes provided.' });
    }
    await ctx.api.patch(`product/${enc(input.product_uuid)}`, {
      body,
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return {
      product_uuid: input.product_uuid,
      changes_applied: Object.keys(body),
      product_url: viewUrl.product(input.product_uuid),
    };
  },
});

export const deleteProduct = defineTool({
  name: 'delete_product',
  description:
    'Delete (default) or archive a product. Hard delete cascades to variants; if the product is synced to channels, unsync it first (sync_to_channel / the web UI) to avoid orphan listings.',
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    archive_only: z.boolean().optional().describe('Default false (hard delete).'),
    workspace: z.string().optional(),
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    if (input.archive_only) {
      await ctx.api.patch(`product/${enc(input.product_uuid)}`, {
        body: { status: 'archived' },
        workspace: input.workspace,
        signal: ctx.signal,
      });
      return { product_uuid: input.product_uuid, deleted: false, archived: true };
    }
    await ctx.api.del(`product/${enc(input.product_uuid)}`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { product_uuid: input.product_uuid, deleted: true };
  },
});

export const productTools: ToolDef[] = [
  shipProduct,
  createProduct,
  addVariants,
  syncToFulfillment,
  syncToChannel,
  updateProduct,
  deleteProduct,
];
