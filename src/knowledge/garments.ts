// Curated garment knowledge (from the skill's garment-catalog guide). This is the "moat"
// data that makes recommend_garment / get_garment_details more than a passthrough: pricing
// floors that prevent negative-margin listings, quality-tier classification, and the
// hard-won variant traps.

// Margin model (garment-catalog.md §Margin math):
//   Profit = (retail + customer shipping) - fulfillment cost - fulfillment shipping
//            - sales-channel fee - creator commission
export const FULFILLMENT_SHIPPING = 5.9;
export const CHANNEL_FEE_RATE = 0.039;
// Minimum margin we bake into the "recommended minimum retail" floor.
export const MIN_MARGIN = 0.2;

function nicePrice(v: number): number {
  // Round up to the next whole dollar, then present as X.99.
  return Math.max(0, Math.ceil(v) - 0.01);
}

/** Recommended MINIMUM retail for a garment at `baseCost`. Positive-margin by construction;
 *  product tools refuse to list below this. Undefined when cost is unknown (e.g. Printify,
 *  which doesn't expose variant cost via the API). */
export function pricingFloor(baseCost: number | undefined): number | undefined {
  if (baseCost === undefined || baseCost <= 0) return undefined;
  const breakEven = (baseCost + FULFILLMENT_SHIPPING) / (1 - CHANNEL_FEE_RATE);
  return nicePrice(breakEven * (1 + MIN_MARGIN));
}

const PREMIUM_BRANDS = [
  'comfort colors',
  'champion',
  'lane seven',
  'allmade',
  'stanley/stella',
  'richardson',
  'mercer+mettle',
];
const BUDGET_BRANDS = ['gildan', 'hanes', 'fruit of the loom', 'jerzees', 'port & company'];

export type QualityTier = 'budget' | 'standard' | 'premium';

export function qualityTier(brand?: string, name?: string): QualityTier {
  const haystack = `${brand ?? ''} ${name ?? ''}`.toLowerCase();
  if (PREMIUM_BRANDS.some((b) => haystack.includes(b))) return 'premium';
  if (BUDGET_BRANDS.some((b) => haystack.includes(b))) return 'budget';
  return 'standard';
}

// Face goods print as a FULL face by default: a raw "placed" design on these leaves contrasting
// borders (white bands) and, when the design still carries its chroma-green keying background,
// prints the green screen onto the product (the canvas/backpack incident, 2026-07-09). Apparel,
// drinkware, and glass keep placed/transparent behavior; embroidery is decided upstream.
// NOTES: apparel is tested FIRST because brand names collide with face-good words ("Bella +
// Canvas 3001" contains "canvas"); 'laptop sleeve' is deliberately specific — a bare /sleeve/
// would misclassify "Long Sleeve Tee" apparel as a fill face.
const APPAREL_RE =
  /t-?shirt|\btee\b|shirt|hoodie|sweatshirt|crewneck|tank|polo|jacket|anorak|windbreaker|leggings|\bdress\b|skirt|shorts|joggers|sweatpants|\bcap\b|beanie|\bhat\b|visor|onesie|bodysuit|romper|\brobe\b|apron/i;
const FILL_FACE_RE =
  /canvas|poster|backpack|duffle|duffel|tote|drawstring|fanny|\bbag\b|\bsocks?\b|towel|blanket|pillow|cushion|\brug\b|doormat|mouse ?pad|desk ?mat|\bcase\b|laptop sleeve|pouch|wallet|luggage tag|\bflag\b|banner|puzzle|notebook|journal/i;

export type PrintStyle = 'placed' | 'fill';

/** Default print style for a garment by name: 'fill' for face goods, 'placed' otherwise
 *  (apparel always placed — the design floats with transparency preserved). */
export function printStyleFor(garmentName: string | undefined): PrintStyle {
  if (!garmentName) return 'placed';
  if (APPAREL_RE.test(garmentName)) return 'placed';
  return FILL_FACE_RE.test(garmentName) ? 'fill' : 'placed';
}

/**
 * How a PLACED design sits vertically. Collar breathing room is a GARMENT concept: on apparel
 * the design hangs below the collar (chest_fill, 13% top padding). On everything else that
 * prints placed (phone cases, mugs, drinkware) the same math shoved the design into the top
 * third — the MOROCCO clear-case incident (top=313/2414: "too far up, not centered") — so
 * non-apparel placed goods CENTER the design on the face instead.
 */
export function placedStyleFor(garmentName: string | undefined): 'chest_fill' | 'back_center' {
  if (!garmentName) return 'chest_fill';
  return APPAREL_RE.test(garmentName) ? 'chest_fill' : 'back_center';
}

/**
 * The print AREA is not always the visible FACE (the WC26 sock/drawstring lesson, 2026-07-09).
 * Wrap-style goods print one file across several physical surfaces, and some templates render
 * the file inverted. A FaceLayout tells the fill compositor where the art must live inside the
 * print area (the background still fills the whole area) and whether to rotate it.
 *
 * Empirically calibrated with grid-file preview renders (numbered bands + edge markers):
 *  - Printful sock `leg_*` placements (e.g. product 882, 632x2620): the file renders 180deg
 *    ROTATED on the sock (file-top = toe), and the strip wraps the leg tube so only the central
 *    ~64% of the width stays frontal — art at 86% width clipped at the silhouette (the ENGLAND
 *    sock incident).
 *  - Drawstring bag wrap areas (e.g. Printify blueprint 414, 4950x11100 ~= 16.5"x37"): the area
 *    is the front + back folded at the bottom — the visible front is the TOP ~50% (grid rows
 *    1-5), the drawstring channel eats the top ~5%, and grommet corner cuts start at ~45%. Art
 *    centered on the AREA straddles the fold (the ENGLAND drawstring incident).
 */
export interface FaceLayout {
  /** Fractions (0..1) of the print area the art must be composed within. */
  face?: { x: number; y: number; w: number; h: number };
  /** Compose the art rotated 180deg (placements that render the file inverted). */
  rotate180?: boolean;
  note: string;
}

const SOCK_LEG_FRONT_RE = /^leg_front_(left|right)$/i;
const SOCK_LEG_BACK_RE = /^leg_back_(left|right)$/i;
const DRAWSTRING_RE = /drawstring|cinch/i;

export function faceLayoutFor(
  garmentName: string | undefined,
  placement: string,
  areaWidth: number,
  areaHeight: number,
): FaceLayout | undefined {
  if (SOCK_LEG_FRONT_RE.test(placement)) {
    return {
      face: { x: 0.18, y: 0.05, w: 0.64, h: 0.9 },
      rotate180: true,
      note: 'Printful sock leg FRONT: renders the file rotated 180deg (file-top = toe) and the strip wraps the leg — art composes inverted, confined to the central band.',
    };
  }
  if (SOCK_LEG_BACK_RE.test(placement)) {
    // Calibrated separately: the BACK strips render the file UPRIGHT (file-top = cuff) —
    // opposite of the fronts. One rotated file on all four strips prints upside down on the
    // backs, so backs get their own non-rotated composition.
    return {
      face: { x: 0.18, y: 0.05, w: 0.64, h: 0.9 },
      note: 'Printful sock leg BACK: renders the file upright (file-top = cuff), central band only.',
    };
  }
  const aspect = areaWidth > 0 && areaHeight > 0 ? areaWidth / areaHeight : 1;
  if (DRAWSTRING_RE.test(garmentName ?? '') && aspect < 0.55) {
    return {
      face: { x: 0.06, y: 0.05, w: 0.88, h: 0.38 },
      note: 'Drawstring bag wrap: the area is front + back folded at the bottom — art composes into the visible front (top half), clear of the drawstring channel and grommet corners.',
    };
  }
  return undefined;
}

/** A fill area with an extreme aspect and NO known face layout is likely a wrap/fold template —
 *  surface a warning so the agent verifies the mockup instead of trusting a blind center. */
export function extremeAspectWarning(
  garmentName: string | undefined,
  placement: string,
  areaWidth: number,
  areaHeight: number,
): string | undefined {
  if (areaWidth <= 0 || areaHeight <= 0) return undefined;
  const aspect = areaWidth / areaHeight;
  if (aspect > 0.5 && aspect < 2.2) return undefined;
  return (
    `Print area "${placement}" on ${garmentName ?? 'this garment'} has an extreme aspect ` +
    `(${areaWidth}x${areaHeight}) with no known face layout — it may wrap several product ` +
    `surfaces (fold/seam in the middle). Inspect the mockup carefully for art straddling a ` +
    `fold or rendering rotated before syncing.`
  );
}

/** BC 3001 (product_ref_id "71") variant-ID trap: 4021-4025 render AQUA, not Navy. Use the
 *  Heather Midnight Navy IDs (8495-8499) instead. Surfaced on get_garment_details. */
export function garmentWarnings(providerRefId: string | undefined): string[] {
  if (providerRefId === '71') {
    return [
      'Bella+Canvas 3001: variant IDs 4021-4025 are AQUA, NOT Navy. For Navy use Heather Midnight Navy (8495-8499). Verify colors against this detail response before adding variants.',
    ];
  }
  return [];
}

export interface CuratedGarment {
  provider: 'Printful' | 'Printify';
  product_ref_id?: string; // known for BC 3001; resolve others via browse_catalog
  brand: string;
  name: string;
  category: string;
  quality_tier: QualityTier;
  recommended_retail: number;
  audiences: string[];
  note: string;
}

// A small, curated shortlist for recommend_garment. Deliberately not exhaustive — it encodes
// the guide's headline trade-offs. The tool tells the agent to resolve exact provider_ref_ids
// / variant matrices via browse_catalog + get_garment_details.
export const CURATED_GARMENTS: CuratedGarment[] = [
  {
    provider: 'Printful',
    product_ref_id: '71',
    brand: 'Bella+Canvas',
    name: '3001 Unisex Short Sleeve Tee',
    category: 't-shirts',
    quality_tier: 'standard',
    recommended_retail: 27.99,
    audiences: ['young_adult', 'athleisure'],
    note: 'The workhorse tee: best balance of quality and cost for volume lines.',
  },
  {
    provider: 'Printful',
    brand: 'Comfort Colors',
    name: '1717 Garment-Dyed Heavyweight Tee',
    category: 't-shirts',
    quality_tier: 'premium',
    recommended_retail: 34.99,
    audiences: ['premium', 'mom_dad'],
    note: 'Heavier (~6.1 oz), pigment-dyed, premium hand-feel: hero / collection pieces at $35+.',
  },
  {
    provider: 'Printful',
    brand: 'Bella+Canvas',
    name: "6400 Women's Relaxed Tee",
    category: 't-shirts',
    quality_tier: 'standard',
    recommended_retail: 34.99,
    audiences: ['mom_dad', 'premium', 'athleisure'],
    note: 'Relaxed women’s fit; good for lifestyle lines targeting an adult audience.',
  },
  {
    provider: 'Printful',
    brand: 'Gildan',
    name: 'Heavy Cotton Tee',
    category: 't-shirts',
    quality_tier: 'budget',
    recommended_retail: 24.99,
    audiences: ['young_adult'],
    note: 'Budget volume body when price is the priority over hand-feel.',
  },
  {
    provider: 'Printful',
    brand: 'Bella+Canvas',
    name: '3719 Fleece Pullover Hoodie',
    category: 'hoodies',
    quality_tier: 'standard',
    recommended_retail: 54.99,
    audiences: ['young_adult', 'athleisure'],
    note: 'Standard pullover hoodie for cooler-weather / streetwear lines.',
  },
];

const AUDIENCE_DEFAULT_TIER: Record<string, QualityTier> = {
  premium: 'premium',
  mom_dad: 'premium',
  athleisure: 'standard',
  young_adult: 'standard',
};

export interface GarmentRecommendation {
  recommendation: CuratedGarment;
  rationale: string;
  alternatives: CuratedGarment[];
}

export function recommendGarment(opts: {
  budget_tier?: string;
  audience?: string;
}): GarmentRecommendation {
  const audience = opts.audience && opts.audience !== 'auto' ? opts.audience : undefined;
  const desiredTier: QualityTier =
    opts.budget_tier && opts.budget_tier !== 'auto'
      ? (opts.budget_tier as QualityTier)
      : audience
        ? (AUDIENCE_DEFAULT_TIER[audience] ?? 'standard')
        : 'standard';

  const scored = CURATED_GARMENTS.map((g) => {
    let score = 0;
    if (g.quality_tier === desiredTier) score += 3;
    if (audience && g.audiences.includes(audience)) score += 2;
    if (g.category === 't-shirts') score += 1; // tees are the default surface
    return { g, score };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0]!.g;
  const alternatives = scored.slice(1, 3).map((s) => s.g);
  const rationale =
    `Recommended a ${desiredTier}-tier ${top.category.replace(/s$/, '')} (${top.brand} ${top.name}): ${top.note} ` +
    `This is a generic recommendation from ApparelHub's garment guide; personalized ranking from your own sales history is not available through this tool yet. ` +
    `Resolve the exact provider_ref_id and variant matrix with browse_catalog / get_garment_details before building.`;

  return { recommendation: top, rationale, alternatives };
}
