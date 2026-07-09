#!/usr/bin/env python3
"""
recompose_fill.py — recompose a design to FILL a product face edge-to-edge.

The canvas/backpack lesson (2026-07-09): printing a raw square design onto a non-apparel
face leaves contrasting borders (white bands) AND, when the design still carries its
chroma-green keying background, prints the green screen onto the product. Face goods
(canvas, posters, backpacks, bags, socks, towels, blankets, pillows, cases, wallets...)
should instead be printed full-bleed: the artwork centered on a background color that
aesthetically matches the artwork's own palette, composed at the print area's exact
aspect ratio (the proven pillow / luggage-tag / pre-compose pattern).

What it does:
  1. Isolate the artwork:
     - image already has real transparency  -> use its alpha as the art mask
     - opaque with a chroma-green screen    -> key the green out (green-dominance test)
     - opaque photo/art with no green       -> "cover" mode: scale + center-crop to the
       target aspect (full-bleed photo, no background needed)
  2. Pick a background color from the artwork's dominant palette (prefers a dark dominant
     so the art pops; a light-only palette gets its dominant darkened), unless --bg is given.
  3. Compose art (scaled, centered, small breathing margin) onto the background at the
     target aspect, flatten to opaque, save as PNG.

Pure stdlib + Pillow (no numpy). Prints JSON metadata on stdout.

Usage:
  recompose_fill.py IN.png OUT.png --aspect 1888:640 [--margin 0.06] [--bg #0B1E3C]

Output (stdout): JSON {"mode": "composited"|"cover", "background": "#RRGGBB"|null,
                       "width": W, "height": H}

Exit codes: 0 ok / 1 Pillow missing / 2 bad args / 5 could not isolate any artwork
"""
import json
import sys
from collections import Counter

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("recompose_fill: Pillow required (pip install Pillow)\n")
    sys.exit(1)

TARGET_LONG_SIDE = 2400  # output resolution: long side of the composed canvas
MIN_ART_ALPHA = 32       # pixels at/above this alpha count as artwork for the bbox


def green_dominant(r, g, b):
    return g > r + 30 and g > b + 30


def luminance(rgb):
    r, g, b = rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def parse_aspect(s):
    try:
        w, h = s.split(":")
        w, h = float(w), float(h)
        if w <= 0 or h <= 0:
            raise ValueError
        return w / h
    except ValueError:
        return None


def pick_background(art_pixels):
    """Dominant-palette background: prefer the darkest of the top color buckets (dark
    backgrounds recede and make the art pop); if everything is light, darken the dominant."""
    buckets = Counter(
        ((r // 24) * 24 + 12, (g // 24) * 24 + 12, (b // 24) * 24 + 12) for (r, g, b) in art_pixels
    )
    total = sum(buckets.values()) or 1
    candidates = [(b, c) for b, c in buckets.most_common(8) if c / total >= 0.03]
    if not candidates:
        candidates = buckets.most_common(1)
    dark = [b for b, _ in candidates if luminance(b) <= 140]
    if dark:
        chosen = min(dark, key=luminance)
    else:
        dominant = candidates[0][0]
        # Darken a light dominant to a deep backdrop shade of itself.
        factor = 60.0 / max(luminance(dominant), 1.0)
        chosen = tuple(max(0, min(255, int(c * factor))) for c in dominant)
    return tuple(int(c) for c in chosen)


def main():
    args = sys.argv[1:]
    aspect = None
    margin = 0.06
    bg_override = None
    for flag in ("--aspect", "--margin", "--bg"):
        if flag in args:
            i = args.index(flag)
            try:
                val = args[i + 1]
            except IndexError:
                sys.stderr.write(f"recompose_fill: {flag} needs a value\n")
                return 2
            if flag == "--aspect":
                aspect = parse_aspect(val)
                if aspect is None:
                    sys.stderr.write("recompose_fill: --aspect must be W:H\n")
                    return 2
            elif flag == "--margin":
                try:
                    margin = max(0.0, min(0.25, float(val)))
                except ValueError:
                    sys.stderr.write("recompose_fill: --margin must be a number\n")
                    return 2
            else:
                v = val.lstrip("#")
                if len(v) != 6:
                    sys.stderr.write("recompose_fill: --bg must be #RRGGBB\n")
                    return 2
                bg_override = tuple(int(v[j:j + 2], 16) for j in (0, 2, 4))
            del args[i:i + 2]
    if len(args) != 2 or aspect is None:
        sys.stderr.write("usage: recompose_fill.py IN OUT --aspect W:H [--margin f] [--bg #hex]\n")
        return 2

    in_path, out_path = args
    try:
        im = Image.open(in_path).convert("RGBA")
    except Exception as e:  # noqa: BLE001 - report and exit
        sys.stderr.write(f"recompose_fill: cannot open {in_path}: {e}\n")
        return 2

    w, h = im.size
    px = im.load()

    # Classify the input.
    alpha = im.split()[-1]
    alpha_data = list(alpha.getdata())
    transparent_share = sum(1 for a in alpha_data if a < MIN_ART_ALPHA) / (len(alpha_data) or 1)

    if transparent_share < 0.02:
        # Opaque. Green screen? Sample the border ring.
        border = []
        step = max(1, w // 64)
        for x in range(0, w, step):
            border.append(px[x, 0][:3])
            border.append(px[x, h - 1][:3])
        step = max(1, h // 64)
        for y in range(0, h, step):
            border.append(px[0, y][:3])
            border.append(px[w - 1, y][:3])
        green_share = sum(1 for c in border if green_dominant(*c)) / (len(border) or 1)

        if green_share >= 0.4:
            # Key the chroma green out (dominance test), then treat as transparent art below.
            data = im.getdata()
            keyed = [
                (255, 255, 255, 0) if green_dominant(r, g, b) else (r, g, b, a)
                for (r, g, b, a) in data
            ]
            im.putdata(keyed)
            alpha = im.split()[-1]
        else:
            # A full-bleed photo/art: cover-fit (scale to cover, center-crop) — no background.
            if aspect >= 1:
                out_w, out_h = TARGET_LONG_SIDE, max(1, round(TARGET_LONG_SIDE / aspect))
            else:
                out_h, out_w = TARGET_LONG_SIDE, max(1, round(TARGET_LONG_SIDE * aspect))
            scale = max(out_w / w, out_h / h)
            rw, rh = max(1, round(w * scale)), max(1, round(h * scale))
            resized = im.resize((rw, rh), Image.LANCZOS).convert("RGB")
            left = (rw - out_w) // 2
            top = (rh - out_h) // 2
            resized.crop((left, top, left + out_w, top + out_h)).save(out_path, "PNG")
            print(json.dumps({"mode": "cover", "background": None, "width": out_w, "height": out_h}))
            return 0

    # Transparent art path: tight-crop to the artwork bbox.
    bbox = alpha.point(lambda a: 255 if a >= MIN_ART_ALPHA else 0).getbbox()
    if bbox is None:
        sys.stderr.write("recompose_fill: no artwork found after keying\n")
        return 5
    art = im.crop(bbox)
    aw, ah = art.size

    art_pixels = [(r, g, b) for (r, g, b, a) in art.getdata() if a >= 200]
    if not art_pixels:
        sys.stderr.write("recompose_fill: artwork has no opaque pixels\n")
        return 5
    bg = bg_override or pick_background(art_pixels)

    if aspect >= 1:
        out_w, out_h = TARGET_LONG_SIDE, max(1, round(TARGET_LONG_SIDE / aspect))
    else:
        out_h, out_w = TARGET_LONG_SIDE, max(1, round(TARGET_LONG_SIDE * aspect))

    avail_w = out_w * (1 - 2 * margin)
    avail_h = out_h * (1 - 2 * margin)
    scale = min(avail_w / aw, avail_h / ah)
    rw, rh = max(1, round(aw * scale)), max(1, round(ah * scale))
    art_resized = art.resize((rw, rh), Image.LANCZOS)

    canvas = Image.new("RGBA", (out_w, out_h), (*bg, 255))
    canvas.paste(art_resized, ((out_w - rw) // 2, (out_h - rh) // 2), art_resized)
    canvas.convert("RGB").save(out_path, "PNG")

    print(json.dumps({
        "mode": "composited",
        "background": "#{:02X}{:02X}{:02X}".format(*bg),
        "width": out_w,
        "height": out_h,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
