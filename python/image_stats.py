#!/usr/bin/env python3
"""Print JSON stats about an image for the MCP verify_design_quality tool:
size, mode, alpha presence, transparent ratio, corner alpha, and whether the
transparent pixels are white-premultiplied (Printful dark-halo guard).

Usage: image_stats.py <path>
"""
import json
import sys

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("image_stats: Pillow required (pip install Pillow)\n")
    sys.exit(1)


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

    # Sample transparent pixels; their RGB should be near-white (pre-multiplied).
    premult_ok = True
    checked = 0
    step_y = max(1, h // 50)
    step_x = max(1, w // 50)
    for y in range(0, h, step_y):
        for x in range(0, w, step_x):
            r, g, b, a = px[x, y]
            if a == 0:
                checked += 1
                if not (r > 240 and g > 240 and b > 240):
                    premult_ok = False

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
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
