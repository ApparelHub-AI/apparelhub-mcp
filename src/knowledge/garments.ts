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
