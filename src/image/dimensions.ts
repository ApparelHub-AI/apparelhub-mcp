// Port of the skill's ah_pick_dimensions math. Given a design's aspect ratio + the garment's
// print area + a placement style, compute (width, height, left, top) for the mockup/print
// payload. Encodes the lesson that Printful CROPS anything outside the print area, so a
// chest-fill design must respect BOTH area width and height (and leave collar breathing room).

export type PlacementStyle = 'chest_fill' | 'chest_emblem' | 'back_center' | 'all_over';

export interface Dimensions {
  width: number;
  height: number;
  left: number;
  top: number;
  rationale: string;
  strategy: string;
}

// Math.trunc matches Python's int() truncation used in the original.
const t = Math.trunc;

export function pickDimensions(
  designW: number,
  designH: number,
  areaW: number,
  areaH: number,
  style: PlacementStyle = 'chest_fill',
  fillRatio = 0.88,
  collarPaddingPct = 0.13,
): Dimensions {
  if (designW <= 0 || designH <= 0) throw new Error('design dimensions must be positive');
  if (areaW <= 0 || areaH <= 0) throw new Error('area dimensions must be positive');
  const designAspect = designW / designH;

  if (style === 'all_over') {
    return {
      width: areaW,
      height: areaH,
      left: 0,
      top: 0,
      rationale:
        `All-over print: fills the entire ${areaW}x${areaH} print area. Design aspect ` +
        `(${designAspect.toFixed(2)}) is ignored — generate the design at the area aspect ` +
        `(${(areaW / areaH).toFixed(2)}) for best results.`,
      strategy: 'fill_ignore_aspect',
    };
  }

  if (style === 'chest_emblem') {
    let targetWidth = t(areaW * 0.35);
    let targetHeight = t(targetWidth / designAspect);
    const maxH = t(areaH * 0.85);
    if (targetHeight > maxH) {
      targetHeight = maxH;
      targetWidth = t(targetHeight * designAspect);
    }
    return {
      width: targetWidth,
      height: targetHeight,
      left: t((areaW - targetWidth) / 2),
      top: t((areaH - targetHeight) / 2),
      rationale:
        `Chest emblem: 35% of area_width = ${targetWidth}px, scaled to ${targetHeight}px to ` +
        `preserve aspect (${designAspect.toFixed(2)}), centered on both axes within ` +
        `${areaW}x${areaH}.`,
      strategy: 'emblem_centered',
    };
  }

  if (style !== 'chest_fill' && style !== 'back_center') {
    throw new Error(`unknown style "${style}"`);
  }

  // Collar padding (chest_fill only): breathing room between the collar seam and the design.
  const collarPadding = style === 'chest_fill' ? Math.max(0, t(areaH * collarPaddingPct)) : 0;
  const availableH = areaH - collarPadding;

  let targetWidth = t(areaW * fillRatio);
  let targetHeight = t(targetWidth / designAspect);
  let constrained = false;
  if (targetHeight > availableH) {
    // Scale DOWN so the design fits entirely within the print area — Printful crops overflow.
    targetHeight = availableH;
    targetWidth = t(targetHeight * designAspect);
    constrained = true;
  }

  const left = t((areaW - targetWidth) / 2);
  const top = style === 'back_center' ? t((areaH - targetHeight) / 2) : collarPadding;
  const widthPct = Math.round((100 * targetWidth) / areaW);

  const bits: string[] = [];
  bits.push(
    constrained
      ? `design aspect (${designAspect.toFixed(2)}) is taller than the available height, so ` +
          `scaled to fit ${targetHeight}px; width ${targetWidth}px = ${widthPct}% of area_width`
      : `${Math.round(fillRatio * 100)}% of area_width = ${targetWidth}px, scaled to ` +
          `${targetHeight}px preserving aspect (${designAspect.toFixed(2)})`,
  );
  bits.push(
    style === 'chest_fill'
      ? `top=${top}px (${Math.round(collarPaddingPct * 100)}% of area_height for collar breathing room)`
      : 'vertically centered for back placement',
  );

  return {
    width: targetWidth,
    height: targetHeight,
    left,
    top,
    rationale: `${bits.join(', ')}.`,
    strategy: constrained ? 'height_constrained' : 'width_constrained',
  };
}
