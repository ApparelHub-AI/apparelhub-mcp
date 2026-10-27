# Bundled tesseract language data

`eng.traineddata` ships here so the WASM OCR fallback (`src/image/imaging.ts`)
can run offline.

Without it, `tesseract.js` downloads the language data from a CDN on first use.
In Lambda that is a multi-megabyte network round trip on a cold start, in a
container that may have no egress — a fetch that can simply fail, turning OCR
back into the "unavailable" state this bundle exists to fix.

Source: the `eng` model shipped with tesseract 5.x (`tessdata` fast/standard
model, Apache-2.0). Referenced via `langPath` with `gzip: false`, because this
is the plain `.traineddata`, not the gzipped form the CDN serves.
