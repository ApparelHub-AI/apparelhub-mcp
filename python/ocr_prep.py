#!/usr/bin/env python3
"""Flatten a design onto a contrasting background so OCR can actually see it.

Designs here are transparent PNGs by convention, and OCR engines composite RGBA
onto WHITE before reading. A pale design -- cream, bone, pastel, any of the
light palettes that print well on dark garments -- therefore becomes white text
on white and reads as noise.

That is not a rare shape. It is the normal one, so without this step hosted OCR
would be close to useless on real designs while still looking like it worked:
it returns *something*, just gibberish.

Measured on a real cream-on-transparent design:
    flattened on white     -> "" (nothing)
    flattened on black     -> "YOU'RE ABSOLUTELY RIGHT"

So: pick the background from the design's own luminance, flatten, and let the
engine read that instead.

Usage:  ocr_prep.py <input> <output>
Prints one JSON line: {"prepared": bool, "background": "#rrggbb"|null}
Exit 0 even when nothing was done -- the caller falls back to the original file.
"""
import json
import sys

try:
    from PIL import Image
except ImportError:
    print(json.dumps({"prepared": False, "background": None, "reason": "pillow_missing"}))
    sys.exit(0)

# Rec. 601 luma, the standard perceptual weighting: the eye is far more
# sensitive to green than blue, so a plain RGB mean misjudges what "light" means.
_R, _G, _B = 0.299, 0.587, 0.114

# Sampling cap. A design can be several thousand pixels square; reading every
# pixel to pick a background colour is wasted work in a Lambda.
_MAX_SAMPLES = 200_000

# Near-white and near-black are both bad backgrounds for their own kind of
# design, so the two options are deliberately not pure: a very dark grey keeps
# some separation from black-ish artwork edges and vice versa.
_DARK_BG = (18, 18, 18)
_LIGHT_BG = (245, 245, 245)


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"prepared": False, "background": None, "reason": "bad_args"}))
        return 0

    src, dst = sys.argv[1], sys.argv[2]
    try:
        img = Image.open(src)
    except Exception:
        print(json.dumps({"prepared": False, "background": None, "reason": "unreadable"}))
        return 0

    if img.mode not in ("RGBA", "LA", "PA") and "transparency" not in img.info:
        # Fully opaque already: whatever contrast it has is what the engine gets.
        print(json.dumps({"prepared": False, "background": None, "reason": "opaque"}))
        return 0

    img = img.convert("RGBA")
    alpha = img.getchannel("A")

    # Judge lightness from the pixels that will actually be printed, not from
    # the transparent field around them -- that is the whole point.
    step = max(1, (img.width * img.height) // _MAX_SAMPLES)
    total = 0.0
    count = 0
    for (r, g, b, a) in list(img.getdata())[::step]:
        if a > 200:
            total += _R * r + _G * g + _B * b
            count += 1

    if count == 0:
        # Nothing opaque to read. Leave it alone rather than inventing contrast.
        print(json.dumps({"prepared": False, "background": None, "reason": "empty"}))
        return 0

    mean_luma = total / count
    background = _DARK_BG if mean_luma > 127 else _LIGHT_BG

    try:
        flat = Image.new("RGB", img.size, background)
        flat.paste(img, mask=alpha)
        flat.save(dst)
    except Exception:
        print(json.dumps({"prepared": False, "background": None, "reason": "write_failed"}))
        return 0

    print(json.dumps({
        "prepared": True,
        "background": "#%02x%02x%02x" % background,
        "mean_luma": round(mean_luma, 1),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
