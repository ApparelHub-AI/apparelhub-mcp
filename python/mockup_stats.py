#!/usr/bin/env python3
"""Print JSON measurements about a rendered product MOCKUP for verify_mockup_quality.

This is the mockup-side counterpart to image_stats.py, which measures a DESIGN.
A design can be perfect and the mockup still wrong: the design is composed onto
the garment by the platform, and that composition is where placement defects
appear (an all-over-print tee that printed only on the chest, a chroma-green
background that was never keyed, a render too small to judge).

What it measures, and why each one exists:

  chroma_green_ratio   Un-keyed green screen that reached the product. This has
                       actually shipped: a design still carrying its #00FF00
                       keying background was printed onto a canvas and a
                       backpack.

  garment_ratio        Fraction of the frame occupied by the product itself,
                       separating it from the (usually white) studio backdrop.
                       Everything below is measured against the GARMENT, not
                       the whole frame, so a tighter or wider product shot does
                       not move the numbers.

  design_coverage      Fraction of the garment carrying design rather than flat
                       fabric. This is the all-over-print check: an AOP garment
                       whose design only reached the chest scores low here,
                       which is exactly the defect that shipped with bare
                       sleeves and a bare hem.

  largest_flat_run     The biggest single uniformly-coloured region on the
                       garment, as a fraction of it. Catches one blank panel on
                       a product that is otherwise printed, which a coverage
                       average alone would hide.

  min_dimension        Render size, for a blurry/unusable preview.

It deliberately does NOT try to judge rotation or seam splits. Deciding whether
a subject is upside down or cut by a fold needs to understand the subject, and
a pixel statistic that guessed at it would be confidently wrong. Those stay a
vision or human call, and verify_mockup_quality says so rather than implying
its silence means "fine".

Usage: mockup_stats.py <path>
"""
import json
import sys

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("mockup_stats: Pillow required (pip install Pillow)\n")
    sys.exit(1)

# Downscale before analysis. These are per-pixel passes in pure Python and a
# mockup is routinely 1000px+ square; the ratios we care about are unaffected.
ANALYSIS_MAX = 220

# A backdrop pixel: near-white and near-neutral. Mockups are shot on white.
BACKDROP_MIN = 244
BACKDROP_SPREAD = 8

# Quantisation bucket for "same colour". Coarse enough that fabric shading and
# JPEG noise do not read as design, fine enough that a real print does.
BUCKET = 24


def _is_backdrop(r, g, b, a):
    if a < 16:
        return True
    if r < BACKDROP_MIN or g < BACKDROP_MIN or b < BACKDROP_MIN:
        return False
    return (max(r, g, b) - min(r, g, b)) <= BACKDROP_SPREAD


def _is_chroma_green(r, g, b):
    # Green clearly dominant and vivid: the signature of an unkeyed #00FF00
    # screen surviving onto the product. Deliberately strict so that genuinely
    # green artwork and green garments do not trip it.
    return g > 110 and g > r + 60 and g > b + 60


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: mockup_stats.py <path>\n")
        return 2
    try:
        im = Image.open(sys.argv[1])
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"mockup_stats: cannot open {sys.argv[1]}: {e}\n")
        return 1

    full_w, full_h = im.size
    rgba = im.convert("RGBA")
    if max(rgba.size) > ANALYSIS_MAX:
        rgba.thumbnail((ANALYSIS_MAX, ANALYSIS_MAX), Image.LANCZOS)
    w, h = rgba.size
    px = rgba.load()

    total = w * h
    garment = []          # (x, y, bucket) for garment pixels
    buckets = {}
    chroma = 0

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if _is_backdrop(r, g, b, a):
                continue
            if _is_chroma_green(r, g, b):
                chroma += 1
            key = (r // BUCKET, g // BUCKET, b // BUCKET)
            buckets[key] = buckets.get(key, 0) + 1
            garment.append((x, y, key))

    n_garment = len(garment)
    if n_garment == 0:
        # Nothing but backdrop: an empty or failed render.
        print(json.dumps({
            "width": full_w, "height": full_h, "min_dimension": min(full_w, full_h),
            "garment_ratio": 0.0, "design_coverage": 0.0,
            "largest_flat_run": 0.0, "chroma_green_ratio": 0.0,
            "dominant_share": 0.0, "distinct_colors": 0, "empty": True,
        }))
        return 0

    # The single most common colour on the garment is the fabric itself.
    # Everything that is NOT that colour is design (or shading, which the
    # coarse bucket mostly folds into the fabric colour).
    dominant_key, dominant_n = max(buckets.items(), key=lambda kv: kv[1])
    design_coverage = 1.0 - (dominant_n / n_garment)

    # Largest contiguous run of the fabric colour, scanline-wise. A cheap
    # stand-in for connected components: a fully blank panel produces long
    # uninterrupted runs, a printed garment does not.
    rows = {}
    for x, y, key in garment:
        rows.setdefault(y, []).append((x, key))
    longest = 0
    for y, cells in rows.items():
        cells.sort()
        run = 0
        prev_x = None
        for x, key in cells:
            contiguous = prev_x is None or x == prev_x + 1
            if key == dominant_key and contiguous:
                run += 1
                longest = max(longest, run)
            else:
                run = 1 if key == dominant_key else 0
            prev_x = x

    print(json.dumps({
        "width": full_w,
        "height": full_h,
        "min_dimension": min(full_w, full_h),
        "garment_ratio": round(n_garment / total, 4),
        "design_coverage": round(design_coverage, 4),
        "largest_flat_run": round(longest / max(w, 1), 4),
        "chroma_green_ratio": round(chroma / n_garment, 4),
        "dominant_share": round(dominant_n / n_garment, 4),
        "distinct_colors": len(buckets),
        "empty": False,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
