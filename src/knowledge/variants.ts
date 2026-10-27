// Variant resolution: map requested (color, size) pairs to provider_variant_ids from a
// garment's variant matrix, and guard the BC 3001 AQUA-vs-Navy trap (Lesson 7).

/** A provider variant id: numeric on Printful/Printify, a string productUid on Gelato. */
export type VariantId = number | string;

export interface MatrixVariant {
  provider_variant_id: VariantId;
  color?: string;
  size?: string;
  cost?: number;
}

export interface RequestedVariant {
  color: string;
  sizes: string[];
  price?: number;
  /** Explicit ids (zipped with sizes) — overrides name resolution. */
  provider_variant_ids?: VariantId[];
}

export interface ResolvedVariant {
  name: string;
  color: string;
  size: string;
  provider_variant_id: VariantId;
  price?: number;
}

export interface ResolveResult {
  resolved: ResolvedVariant[];
  warnings: string[];
  unresolved: { color: string; size: string }[];
}

// BC 3001 (product_ref_id "71") variant ids 4021-4025 render AQUA — a classic mislabel-as-Navy trap.
const BC3001_AQUA_IDS = new Set([4021, 4022, 4023, 4024, 4025]);

function norm(s?: string): string {
  return (s ?? '').toLowerCase().trim();
}

function sameColor(matrix?: string, requested?: string): boolean {
  const a = norm(matrix);
  const b = norm(requested);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

function sameSize(matrix?: string, requested?: string): boolean {
  return norm(matrix) === norm(requested);
}

export function resolveVariants(
  matrix: MatrixVariant[],
  requested: RequestedVariant[],
  productRefId?: string,
  defaultPrice?: number,
): ResolveResult {
  const resolved: ResolvedVariant[] = [];
  const warnings: string[] = [];
  const unresolved: { color: string; size: string }[] = [];

  // Single-dimension garments: many non-apparel goods carry NO color (clear phone cases: the
  // catalog has only device sizes) or NO size (one-size posters in named colors). Requiring a
  // match on a dimension the matrix doesn't have resolves 0 variants and fails the whole build
  // (the MOROCCO phone-case incident, 2026-07-09) — skip the missing dimension and keep the
  // requested name as the variant label.
  const matrixHasColors = matrix.some((m) => norm(m.color));
  const matrixHasSizes = matrix.some((m) => norm(m.size));
  if (!matrixHasColors && requested.some((r) => norm(r.color))) {
    warnings.push(
      'This garment has no color dimension in its catalog — variants matched by size only (the requested color is kept as the variant label).',
    );
  }
  if (!matrixHasSizes && requested.some((r) => r.sizes.some((s) => norm(s)))) {
    warnings.push(
      'This garment has no size dimension in its catalog — variants matched by color only (the requested size is kept as the variant label).',
    );
  }

  for (const req of requested) {
    const price = req.price ?? defaultPrice;
    req.sizes.forEach((size, i) => {
      let vid: VariantId | undefined;
      if (req.provider_variant_ids && req.provider_variant_ids[i] !== undefined) {
        vid = req.provider_variant_ids[i];
      } else {
        const match = matrix.find(
          (m) =>
            (matrixHasColors ? sameColor(m.color, req.color) : true) &&
            (matrixHasSizes ? sameSize(m.size, size) : true),
        );
        vid = match?.provider_variant_id;
      }
      if (vid === undefined) {
        unresolved.push({ color: req.color, size });
        return;
      }
      if (
        productRefId === '71' &&
        typeof vid === 'number' &&
        BC3001_AQUA_IDS.has(vid) &&
        /navy/i.test(req.color)
      ) {
        warnings.push(
          `Requested "${req.color}" ${size} resolved to variant ${vid}, which is AQUA on BC 3001, not Navy. ` +
            `Use Heather Midnight Navy (8495-8499) instead.`,
        );
      }
      resolved.push({ name: req.color, color: req.color, size, provider_variant_id: vid, price });
    });
  }

  return { resolved, warnings, unresolved };
}
