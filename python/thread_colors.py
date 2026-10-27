#!/usr/bin/env python3
"""
thread_colors.py — derive Printful embroidery thread colors from a design.

Printful embroidery sync requires a variant-level thread_colors_<placement> option whose
values come from Printful's FIXED 15-color thread palette. This script reads the design's
dominant colors and maps each to its perceptually-nearest palette entry using CIE Lab
distance (raw RGB distance mis-categorizes bronze golds as orange — Lesson 61 family).

Pure stdlib + Pillow (no numpy), matching the rest of the packaged toolchain.

Usage:
  thread_colors.py IMAGE [--max 5]

Output (stdout): JSON {"thread_colors": ["#01784E", ...], "coverage": {"#01784E": 0.41, ...}}

Exit codes:
  0 = ok
  1 = Pillow missing
  2 = bad args / unreadable image
  3 = no analyzable (opaque, non-background) pixels found
"""
import json
import sys
from collections import Counter

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("thread_colors: Pillow required (pip install Pillow)\n")
    sys.exit(1)

PALETTE = [
    "#FFFFFF", "#000000", "#96A1A8", "#A67843", "#FFCC00",
    "#E25C27", "#CC3366", "#CC3333", "#660000", "#333366",
    "#005397", "#3399FF", "#6B5294", "#01784E", "#7BA35A",
]

# Buckets smaller than this share of analyzable pixels are noise (anti-aliased edges).
MIN_BUCKET_SHARE = 0.02
MAX_SAMPLE_EDGE = 256  # downscale for speed; dominance is scale-invariant


def _srgb_to_lab(r, g, b):
    """sRGB (0-255) -> CIE Lab (D65). Standard two-step conversion, pure python."""

    def lin(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    rl, gl, bl = lin(r), lin(g), lin(b)
    # sRGB D65 matrix
    x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
    y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750
    z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041
    # Normalize by D65 white point
    xn, yn, zn = x / 0.95047, y / 1.0, z / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else (7.787 * t) + (16 / 116)

    fx, fy, fz = f(xn), f(yn), f(zn)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


_PALETTE_LAB = [(_srgb_to_lab(int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)), h) for h in PALETTE]


def nearest_palette(rgb):
    lab = _srgb_to_lab(*rgb)
    best, best_d = PALETTE[0], float("inf")
    for plab, phex in _PALETTE_LAB:
        d = (lab[0] - plab[0]) ** 2 + (lab[1] - plab[1]) ** 2 + (lab[2] - plab[2]) ** 2
        if d < best_d:
            best, best_d = phex, d
    return best


def green_dominant(r, g, b):
    """The chroma-key background test: green clearly outweighs red AND blue."""
    return g > r + 30 and g > b + 30


def main():
    args = sys.argv[1:]
    max_colors = 5
    if "--max" in args:
        i = args.index("--max")
        try:
            max_colors = max(1, min(6, int(args[i + 1])))
        except (IndexError, ValueError):
            sys.stderr.write("thread_colors: --max needs an integer\n")
            return 2
        del args[i:i + 2]
    if len(args) != 1:
        sys.stderr.write("usage: thread_colors.py IMAGE [--max N]\n")
        return 2
    try:
        im = Image.open(args[0])
    except Exception as e:  # noqa: BLE001 - report and exit
        sys.stderr.write(f"thread_colors: cannot open {args[0]}: {e}\n")
        return 2

    im.thumbnail((MAX_SAMPLE_EDGE, MAX_SAMPLE_EDGE))
    rgba = im.convert("RGBA")
    px = list(rgba.getdata())

    opaque = [(r, g, b) for (r, g, b, a) in px if a >= 200]
    if not opaque:
        sys.stderr.write("thread_colors: image is fully transparent\n")
        return 3

    # If the design was never keyed (opaque green screen), exclude the chroma background —
    # otherwise "green" would dominate every un-keyed design. Keep everything when that would
    # exclude nearly the whole image (a deliberately green design).
    non_green = [c for c in opaque if not green_dominant(*c)]
    analyzable = non_green if len(non_green) >= max(64, int(len(opaque) * 0.05)) else opaque

    buckets = Counter(((r // 24) * 24 + 12, (g // 24) * 24 + 12, (b // 24) * 24 + 12) for (r, g, b) in analyzable)
    total = len(analyzable)

    coverage = {}
    for bucket, count in buckets.most_common(12):
        share = count / total
        if share < MIN_BUCKET_SHARE:
            break
        phex = nearest_palette(bucket)
        coverage[phex] = coverage.get(phex, 0.0) + share

    if not coverage:
        # Degenerate (single near-uniform bucket under threshold?) — map the mean color.
        mean = tuple(sum(c[i] for c in analyzable) // total for i in range(3))
        coverage[nearest_palette(mean)] = 1.0

    ordered = sorted(coverage.items(), key=lambda kv: kv[1], reverse=True)[:max_colors]
    print(json.dumps({
        "thread_colors": [h for h, _ in ordered],
        "coverage": {h: round(s, 4) for h, s in ordered},
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
