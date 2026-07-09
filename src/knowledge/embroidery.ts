import { AhError } from '../errors.js';

// Printful embroidery knowledge (Lesson 61 + the 2026-07-09 cap/beanie incident).
//
// Embroidery garments (caps, beanies, some apparel placements) are STITCHED, not printed:
//  - The print file must target an `embroidery_*` placement, never `front` — Printful rejects a
//    print placement on an embroidery-only garment with "File type front is not allowed".
//  - Syncing to Printful additionally REQUIRES a variant-level `thread_colors_<placement>` option
//    whose values come from Printful's FIXED 15-color thread palette. The platform hoists an
//    `options` array from each print_data/print_files entry up to the sync-variant level
//    (confirmed empirically 2026-05-23), so the MCP attaches the option to the print_data template.

export const PRINTFUL_THREAD_PALETTE = [
  '#FFFFFF',
  '#000000',
  '#96A1A8',
  '#A67843',
  '#FFCC00',
  '#E25C27',
  '#CC3366',
  '#CC3333',
  '#660000',
  '#333366',
  '#005397',
  '#3399FF',
  '#6B5294',
  '#01784E',
  '#7BA35A',
] as const;

const PALETTE_SET = new Set<string>(PRINTFUL_THREAD_PALETTE);

/** Max thread colors we attach per design — each extra color raises stitch density and price. */
export const MAX_THREAD_COLORS = 6;

export function isEmbroideryPlacement(placement: string | undefined): boolean {
  return /embroider/i.test(placement ?? '');
}

/**
 * The Printful option id for a placement's thread colors is placement-suffixed:
 * `embroidery_front_large` -> `thread_colors_front_large`,
 * `embroidery_chest_left`  -> `thread_colors_chest_left` (the empirically verified shape).
 */
export function threadColorsOptionId(placement: string): string {
  return `thread_colors_${placement.replace(/^addon_/i, '').replace(/^embroidery_/i, '')}`;
}

/**
 * Validate + normalize a thread-color list against the fixed palette (uppercase, deduped,
 * capped). Throws a structured error naming the palette when a color is off-palette — Printful
 * rejects the ENTIRE sync call for a single bad value, so failing here is strictly better.
 */
export function normalizeThreadColors(colors: string[]): string[] {
  const out: string[] = [];
  for (const c of colors) {
    const up = c.trim().toUpperCase();
    if (!PALETTE_SET.has(up)) {
      throw new AhError({
        code: 'bad_request',
        message: `Thread color ${c} is not in Printful's fixed 15-color embroidery palette.`,
        suggestion: `Use only: ${PRINTFUL_THREAD_PALETTE.join(', ')}.`,
      });
    }
    if (!out.includes(up)) out.push(up);
  }
  if (out.length === 0) {
    throw new AhError({
      code: 'bad_request',
      message: 'At least one thread color from the Printful palette is required for embroidery.',
    });
  }
  return out.slice(0, MAX_THREAD_COLORS);
}
