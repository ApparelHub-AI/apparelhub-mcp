#!/usr/bin/env python3
"""
ensure_resolution.py — upscale a print design so it meets a minimum pixel resolution.

The WC26 passport-wallet lesson (2026-07-09): an AI design generated at 1024px, keyed and
auto-cropped to its artwork bbox, can shrink to e.g. 847x596. Placed straight onto a large
print area, the effective print DPI is too low and the fulfillment platform's QC gate BLOCKS
the product ("low resolution") — with no automatic remediation the build dead-ends.

This is the missing "regenerate at higher resolution" step, done mechanically: if the design's
long side is below the floor, Lanczos-upscale it to the floor (preserving aspect). Upscaling
doesn't invent detail, but it clears the platform's pixels-per-inch gate — which is what every
POD tool does — so a product never hard-blocks on resolution alone. Callers that need genuine
detail at large format should regenerate the source design instead of relying on this.

Transparency is preserved and transparent pixels are premultiplied white (so Printful doesn't
flatten them to a black halo — Lesson 9).

Pure stdlib + Pillow. Prints JSON metadata on stdout.

Usage:
  ensure_resolution.py IN.png OUT.png --min-long-side 2400

Output (stdout): JSON {"upscaled": bool, "width": W, "height": H, "from": [w0, h0]}
Exit codes: 0 ok / 1 Pillow missing / 2 bad args
"""
import json
import sys

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("ensure_resolution: Pillow required (pip install Pillow)\n")
    sys.exit(1)

HARD_CAP = 5000  # never produce a file larger than this on the long side


def main():
    args = sys.argv[1:]
    min_long = None
    if "--min-long-side" in args:
        i = args.index("--min-long-side")
        try:
            min_long = int(args[i + 1])
        except (IndexError, ValueError):
            sys.stderr.write("ensure_resolution: --min-long-side needs an integer\n")
            return 2
        del args[i:i + 2]
    if len(args) != 2 or min_long is None:
        sys.stderr.write("usage: ensure_resolution.py IN OUT --min-long-side N\n")
        return 2
    min_long = max(1, min(min_long, HARD_CAP))

    in_path, out_path = args
    try:
        im = Image.open(in_path).convert("RGBA")
    except Exception as e:  # noqa: BLE001 - report and exit
        sys.stderr.write(f"ensure_resolution: cannot open {in_path}: {e}\n")
        return 2

    w0, h0 = im.size
    long_side = max(w0, h0)
    upscaled = False
    if long_side < min_long:
        scale = min_long / long_side
        w1, h1 = max(1, round(w0 * scale)), max(1, round(h0 * scale))
        im = im.resize((w1, h1), Image.LANCZOS)
        upscaled = True

    # Premultiply transparent pixels with white so the fulfillment provider doesn't flatten
    # them to black (Lesson 9). Only touches fully/near-transparent pixels.
    px = im.getdata()
    im.putdata([(255, 255, 255, a) if a < 8 else (r, g, b, a) for (r, g, b, a) in px])

    im.save(out_path, "PNG")
    print(json.dumps({
        "upscaled": upscaled,
        "width": im.size[0],
        "height": im.size[1],
        "from": [w0, h0],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
