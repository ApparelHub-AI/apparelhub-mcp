#!/usr/bin/env python3
"""Print JSON stats about an image for the MCP verify_design_quality tool:
size, mode, alpha presence, transparent ratio, corner alpha, whether the
transparent pixels are white-premultiplied (Printful dark-halo guard), plus the
two defect signals added for apparelhub-mcp#763.

#763: verify_design_quality graded 100/100 on designs carrying a solid-black box
artifact and a visible green chroma halo. Nothing here measured either, so the
scorer could not possibly have seen them — it only knew about alpha, resolution
and premultiply. Two measurements close that:

  chroma_halo_ratio  fraction of OPAQUE pixels still chroma-key green. Keying
                     removes the background but can leave a fringe along the
                     alpha edge, which prints as a green outline on the garment.
  black_box_ratio    fraction of opaque pixels that are near-black AND sit in a
                     dense rectangular block — the artifact some models emit,
                     which prints as a filled slab. Density is what separates it
                     from legitimate black linework or a black silhouette.

Usage: image_stats.py <path>
"""
import json
import sys

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("image_stats: Pillow required (pip install Pillow)\n")
    sys.exit(1)


def _is_chroma_green(r, g, b):
    """A surviving #00FF00 screen pixel, or a halo pixel blended toward it.

    STRICTER than mockup_stats._is_chroma_green, and deliberately so. On a mockup,
    a vivid green pixel on a garment is almost certainly unkeyed screen. On a
    DESIGN, green is a legitimate artwork colour — foliage, a lime logo, a forest
    silhouette — so the mockup threshold (g>110) flags real art as a defect. The
    signature that matters here is near-pure chroma: very high green with both
    other channels genuinely low.
    """
    return g > 180 and r < 120 and b < 120 and g - max(r, b) > 90


def _is_near_black(r, g, b):
    """Near-black: every channel dark AND close together (a true black, not navy)."""
    return r < 40 and g < 40 and b < 40 and max(r, g, b) - min(r, g, b) < 18


def _largest_black_block_ratio(px, w, h, opaque_pixels):
    """Fraction of the opaque design occupied by a solid near-black RECTANGLE.

    Coarse grid scan rather than connected components: the artifact is a large
    axis-aligned slab, and a grid finds it while staying fast on a 4000px design.
    A cell counts as black only when nearly all of its sampled pixels are
    near-black, so anti-aliased linework and small black text — sparse at cell
    scale — do not register.

    ⚠️ Rectangularity is the whole discriminator. A black SILHOUETTE is a
    legitimate design and is often the entire subject, so "lots of black" cannot
    be the test. The largest axis-aligned rectangle inscribed in an ellipse covers
    only ~64% of it, while an actual rectangular slab covers ~100% — so we report
    a defect only when the black region really is rectangle-shaped.

    `opaque_pixels` must be a FULL-RESOLUTION count; the returned ratio is in
    full-resolution pixels too.
    """
    if opaque_pixels <= 0:
        return 0.0

    cells_x = 24
    cells_y = 24
    cell_w = max(1, w // cells_x)
    cell_h = max(1, h // cells_y)
    # Sample a few points per cell rather than every pixel.
    sx = max(1, cell_w // 4)
    sy = max(1, cell_h // 4)

    grid = []
    for cy in range(cells_y):
        row = []
        for cx in range(cells_x):
            x0, y0 = cx * cell_w, cy * cell_h
            x1, y1 = min(w, x0 + cell_w), min(h, y0 + cell_h)
            sampled = 0
            black = 0
            for y in range(y0, y1, sy):
                for x in range(x0, x1, sx):
                    r, g, b, a = px[x, y]
                    if a < 200:
                        continue
                    sampled += 1
                    if _is_near_black(r, g, b):
                        black += 1
            # >=90% of an opaque cell being near-black = a solid block, not detail.
            row.append(1 if sampled >= 4 and black >= sampled * 0.9 else 0)
        grid.append(row)

    total_black_cells = sum(sum(row) for row in grid)
    if not total_black_cells:
        return 0.0

    # Largest all-black axis-aligned rectangle over the grid (histogram method).
    best = 0
    heights = [0] * cells_x
    for cy in range(cells_y):
        for cx in range(cells_x):
            heights[cx] = heights[cx] + 1 if grid[cy][cx] else 0
        # Largest rectangle in this histogram row.
        stack = []
        for cx in range(cells_x + 1):
            cur = heights[cx] if cx < cells_x else 0
            while stack and heights[stack[-1]] >= cur:
                height = heights[stack.pop()]
                width = cx - (stack[-1] + 1 if stack else 0)
                best = max(best, height * width)
            stack.append(cx)

    # Is the black region actually a rectangle? ~1.0 for a slab, ~0.64 for an
    # ellipse (the inscribed-rectangle ratio), lower still for irregular art.
    rectangularity = best / total_black_cells
    if rectangularity < 0.85:
        return 0.0

    block_pixels = best * cell_w * cell_h
    return min(1.0, block_pixels / opaque_pixels)


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: image_stats.py <path>\n")
        return 2
    try:
        im = Image.open(sys.argv[1])
    except Exception as e:  # noqa: BLE001 - report and exit
        sys.stderr.write(f"image_stats: cannot open {sys.argv[1]}: {e}\n")
        return 1

    w, h = im.size
    mode = im.mode
    has_alpha = mode in ("RGBA", "LA") or (mode == "P" and "transparency" in im.info)

    rgba = im.convert("RGBA")
    px = rgba.load()
    alpha_data = list(rgba.split()[-1].getdata())
    n = len(alpha_data) or 1
    transparent = sum(1 for a in alpha_data if a == 0)
    corners = [px[0, 0][3], px[w - 1, 0][3], px[0, h - 1][3], px[w - 1, h - 1][3]]

    # One sampling pass: premultiply check + chroma-halo ratio (#763).
    premult_ok = True
    checked = 0
    opaque_sampled = 0
    chroma_sampled = 0
    step_y = max(1, h // 50)
    step_x = max(1, w // 50)
    for y in range(0, h, step_y):
        for x in range(0, w, step_x):
            r, g, b, a = px[x, y]
            if a == 0:
                checked += 1
                if not (r > 240 and g > 240 and b > 240):
                    premult_ok = False
            elif a > 200:
                opaque_sampled += 1
                if _is_chroma_green(r, g, b):
                    chroma_sampled += 1

    chroma_halo_ratio = (chroma_sampled / opaque_sampled) if opaque_sampled else 0.0
    # Full-resolution opaque count — the block measurement is in real pixels, so
    # dividing it by a SAMPLED count would inflate the ratio ~300x.
    opaque_pixels = sum(1 for a in alpha_data if a > 200)
    black_box_ratio = _largest_black_block_ratio(px, w, h, opaque_pixels)

    print(
        json.dumps(
            {
                "width": w,
                "height": h,
                "mode": mode,
                "has_alpha": bool(has_alpha),
                "transparent_ratio": transparent / n,
                "corner_alpha": [int(c) for c in corners],
                "premultiplied_white": bool(premult_ok if checked else True),
                # #763 defect signals.
                "chroma_halo_ratio": chroma_halo_ratio,
                "black_box_ratio": black_box_ratio,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
