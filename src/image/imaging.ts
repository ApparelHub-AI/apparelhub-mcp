import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AhError } from '../errors.js';

// The local image toolchain the design tools shell out to. Bundled make_transparent.py does the
// chroma-key transparency; Pillow reports sizes; tesseract (if present) does OCR text detection.
// All of this runs on the USER's machine (local MCP); when a dependency is missing the tools
// return a structured degrade notice that names the missing dependency + the install command
// (spec §0), never a crash.

const MAKE_TRANSPARENT = fileURLToPath(
  new URL('../../python/make_transparent.py', import.meta.url),
);
const IMAGE_STATS = fileURLToPath(new URL('../../python/image_stats.py', import.meta.url));
const MOCKUP_STATS = fileURLToPath(new URL('../../python/mockup_stats.py', import.meta.url));
const THREAD_COLORS = fileURLToPath(new URL('../../python/thread_colors.py', import.meta.url));
const ENSURE_RESOLUTION = fileURLToPath(new URL('../../python/ensure_resolution.py', import.meta.url));
const OCR_PREP = fileURLToPath(new URL('../../python/ocr_prep.py', import.meta.url));
const PYTHON = process.env.APPARELHUB_MCP_PYTHON || 'python3';

export interface ImageStats {
  width: number;
  height: number;
  mode: string;
  has_alpha: boolean;
  transparent_ratio: number;
  corner_alpha: number[];
  premultiplied_white: boolean;
  /** Fraction of OPAQUE pixels still chroma-key green — a keying fringe that
   *  prints as a green outline on the garment (#763). Optional so an older
   *  image_stats.py that does not emit it degrades to "not measured". */
  chroma_halo_ratio?: number;
  /** Fraction of the opaque design occupied by a solid near-black RECTANGLE — the
   *  slab artifact some models emit (#763). Rectangularity-gated, so a black
   *  silhouette or black linework reads 0. */
  black_box_ratio?: number;
}

/** Measurements of a rendered product MOCKUP (not a design). See
 *  python/mockup_stats.py for what each field means and why it exists. */
export interface MockupStats {
  width: number;
  height: number;
  min_dimension: number;
  garment_ratio: number;
  design_coverage: number;
  largest_flat_run: number;
  chroma_green_ratio: number;
  dominant_share: number;
  distinct_colors: number;
  empty: boolean;
}

export interface TransparencyResult {
  outputPath: string;
  /** true when all four corners keyed fully transparent (make_transparent exit 0). */
  cornersClean: boolean;
  width?: number;
  height?: number;
}

export interface MakeTransparentOptions {
  /**
   * How to match the background.
   *  - 'box' (default): tight color box around the auto-detected corner chroma, guarded by a
   *    sanity check that refuses a background far from pure #00FF00 (exit 4 -> `chroma_background`).
   *  - 'dominance': "green dominates" test — robust to the tinted / muted / gradient greens the AI
   *    models actually produce. Only clears pixels where green clearly outweighs red AND blue, so
   *    charcoal / white / warm (yellow, gold, orange) art is preserved. No sanity check.
   */
  mode?: 'box' | 'dominance';
  /** Bypass the box-mode chroma sanity check (`--force-chroma`). Ignored in dominance mode. */
  force?: boolean;
}

export interface RecomposeFillOptions {
  /** Visible-face rectangles (fractions of the print area) the art is composed into — one per
   *  physical face the file covers; the background still fills the whole area. A face with
   *  `rotate180` renders inverted on the product (far side of a fold), so the art is flipped
   *  there. Wrap-style goods: drawstring bags, sock legs, zipper wallets. */
  faces?: { x: number; y: number; w: number; h: number; rotate180?: boolean }[];
  /** Compose onto a TRANSPARENT canvas (placed-style wrap goods: per-face art, transparency
   *  preserved, transparent pixels premultiplied white). */
  transparent?: boolean;
}

export interface EnsureResolutionResult {
  outputPath: string;
  /** true when the design was actually upscaled (false = already >= the floor, unchanged). */
  upscaled: boolean;
  width?: number;
  height?: number;
}

export interface OcrResult {
  /** False = OCR could not run at all. Distinct from "ran and found nothing". */
  available: boolean;
  text: string;
  /** Mean per-word confidence 0-100, or null when the engine reported none. */
  confidence: number | null;
  /** Which engine answered — useful when a caller wants to explain a result. */
  engine?: 'native' | 'wasm';
}

export interface Imaging {
  downloadToTemp(url: string, ext?: string): Promise<string>;
  makeTransparent(inputPath: string, opts?: MakeTransparentOptions): Promise<TransparencyResult>;
  readBytes(path: string): Promise<Uint8Array>;
  imageSize(path: string): Promise<{ width: number; height: number } | undefined>;
  /** Full quality stats (alpha, transparency, premultiply). Undefined if Python/Pillow missing. */
  imageStats(path: string): Promise<ImageStats | undefined>;
  /** Measure a rendered product mockup (chroma leak, blankness, resolution). */
  mockupStats(path: string): Promise<MockupStats | undefined>;
  /** Read text from an image.
   *
   *  `confidence` is tesseract's mean per-word score (0-100), or null when the
   *  engine could not report one. It matters as much as the text: tesseract
   *  returns fluent-looking garbage on stylized display faces, so a caller that
   *  treats every non-empty result as authoritative will assert a misspelling on
   *  a design that is perfectly fine. Measured locally on a distorted design:
   *  garbage came back at confidence 24, correct reads at 96. */
  ocr(imagePath: string): Promise<OcrResult>;
  /** Dominant design colors mapped to Printful's fixed embroidery thread palette (CIE Lab). */
  threadColors(inputPath: string, max?: number): Promise<string[]>;
  /** Upscale a design to a minimum long-side resolution (Lanczos, white-premultiplied) so it
   *  clears the fulfillment platform's low-resolution QC gate. No-op if already large enough. */
  ensureResolution(inputPath: string, minLongSide: number): Promise<EnsureResolutionResult>;
  cleanup(paths: string[]): Promise<void>;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function pythonMissing(): AhError {
  return new AhError({
    code: 'local_tool_unavailable',
    message:
      'This step needs local image processing (Python 3 + the Pillow library), which is not available in this environment.',
    suggestion:
      'Install it and retry: `pip3 install Pillow` (and make sure `python3` is on PATH). Alternatively, run this step in the ApparelHub web app.',
  });
}

function looksLikeMissingInterpreter(r: { code: number; stderr: string }): boolean {
  return (
    r.code === 127 ||
    /ModuleNotFoundError|No module named ['"]?PIL|command not found|ENOENT|not found/i.test(r.stderr)
  );
}

export class LocalImaging implements Imaging {
  private tmpRoot: Promise<string> | undefined;

  private dir(): Promise<string> {
    if (!this.tmpRoot) this.tmpRoot = mkdtemp(join(tmpdir(), 'ah-mcp-'));
    return this.tmpRoot;
  }

  async downloadToTemp(url: string, ext = '.png'): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new AhError({
        code: 'download_failed',
        message: `Failed to download the image (${res.status}).`,
      });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const p = join(await this.dir(), `dl-${Date.now()}-${buf.length % 100000}${ext}`);
    await writeFile(p, buf);
    return p;
  }

  async makeTransparent(inputPath: string, opts: MakeTransparentOptions = {}): Promise<TransparencyResult> {
    const out = join(await this.dir(), `t-${Date.now()}.png`);
    const args = [MAKE_TRANSPARENT, inputPath, out];
    if (opts.mode === 'dominance') args.push('--dominance');
    if (opts.force) args.push('--force-chroma');
    let r: RunResult;
    try {
      r = await run(PYTHON, args);
    } catch {
      throw pythonMissing();
    }
    // exit 4 = the auto-detected background isn't close to pure #00FF00, so box-keying it with the
    // default tolerance risks eating warm design elements. Surface a DISTINCT code so the caller can
    // retry in green-dominance mode (safe for the tinted / muted greens AI models actually produce)
    // instead of dead-ending.
    if (r.code === 4) {
      throw new AhError({
        code: 'chroma_background',
        message:
          'The generated background is a tinted or muted green, not pure #00FF00, so the standard keyer refused it to avoid eating warm design elements.',
        suggestion: 'Retry in dominance mode (safe for tinted green screens) or force box-keying.',
      });
    }
    // exit 0 = clean; exit 3 = written but corners not fully transparent (still usable, warn).
    if (r.code !== 0 && r.code !== 3) {
      if (looksLikeMissingInterpreter(r)) throw pythonMissing();
      throw new AhError({
        code: 'transparency_failed',
        message: `Transparency processing failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      });
    }
    const size = await this.imageSize(out);
    return { outputPath: out, cornersClean: r.code === 0, width: size?.width, height: size?.height };
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  }

  async imageSize(path: string): Promise<{ width: number; height: number } | undefined> {
    try {
      const r = await run(PYTHON, [
        '-c',
        'from PIL import Image;import sys;w,h=Image.open(sys.argv[1]).size;print(w,h)',
        path,
      ]);
      if (r.code !== 0) return undefined;
      const [w, h] = r.stdout.trim().split(/\s+/).map(Number);
      if (Number.isFinite(w) && Number.isFinite(h)) return { width: w!, height: h! };
    } catch {
      // best-effort: an unknown size just means downstream sizing can't use it.
      return undefined;
    }
    return undefined;
  }

  async mockupStats(path: string): Promise<MockupStats | undefined> {
    let r: RunResult;
    try {
      r = await run(PYTHON, [MOCKUP_STATS, path]);
    } catch {
      return undefined;
    }
    if (r.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout.trim()) as MockupStats;
    } catch {
      return undefined;
    }
  }

  async imageStats(path: string): Promise<ImageStats | undefined> {
    let r: RunResult;
    try {
      r = await run(PYTHON, [IMAGE_STATS, path]);
    } catch {
      return undefined;
    }
    if (r.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout.trim()) as ImageStats;
    } catch {
      return undefined;
    }
  }

  async threadColors(inputPath: string, max = 5): Promise<string[]> {
    let r: RunResult;
    try {
      r = await run(PYTHON, [THREAD_COLORS, inputPath, '--max', String(max)]);
    } catch {
      throw pythonMissing();
    }
    if (r.code !== 0) {
      if (looksLikeMissingInterpreter(r)) throw pythonMissing();
      throw new AhError({
        code: 'thread_colors_failed',
        message: `Thread-color derivation failed: ${r.stderr.trim() || `exit ${r.code}`}`,
        suggestion: 'Pass thread_colors explicitly from the Printful 15-color palette.',
      });
    }
    try {
      const parsed = JSON.parse(r.stdout.trim()) as { thread_colors?: string[] };
      const colors = parsed.thread_colors ?? [];
      if (!colors.length) throw new Error('empty');
      return colors;
    } catch {
      throw new AhError({
        code: 'thread_colors_failed',
        message: 'Thread-color derivation returned no colors.',
        suggestion: 'Pass thread_colors explicitly from the Printful 15-color palette.',
      });
    }
  }

  async ensureResolution(inputPath: string, minLongSide: number): Promise<EnsureResolutionResult> {
    const out = join(
      await this.dir(),
      `res-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`,
    );
    let r: RunResult;
    try {
      r = await run(PYTHON, [ENSURE_RESOLUTION, inputPath, out, '--min-long-side', String(minLongSide)]);
    } catch {
      throw pythonMissing();
    }
    if (r.code !== 0) {
      if (looksLikeMissingInterpreter(r)) throw pythonMissing();
      throw new AhError({
        code: 'recompose_failed',
        message: `Resolution upscale failed: ${r.stderr.trim() || `exit ${r.code}`}`,
        suggestion: 'Retry, or regenerate the design at a higher resolution.',
      });
    }
    let meta: { upscaled?: boolean; width?: number; height?: number } = {};
    try {
      meta = JSON.parse(r.stdout.trim()) as typeof meta;
    } catch {
      // Metadata is advisory; the output file is the contract.
    }
    return {
      outputPath: out,
      upscaled: Boolean(meta.upscaled),
      width: meta.width,
      height: meta.height,
    };
  }

  async ocr(imagePath: string): Promise<OcrResult> {
    // Designs here are transparent PNGs by convention and OCR engines composite
    // RGBA onto WHITE, so a pale design reads as white-on-white noise. Flatten
    // onto a contrasting background first; see python/ocr_prep.py.
    const prepared = await prepareForOcr(imagePath);
    try {
      // Native binary first: faster than the WASM build, and what a developer
      // with tesseract on PATH already expects to be used.
      try {
        // `tsv` rather than plain text: it carries a per-word confidence column,
        // and plain text alone cannot tell a clean read from convincing garbage.
        const r = await run('tesseract', [prepared, 'stdout', 'tsv']);
        if (r.code === 0)
          return { ...parseTesseractTsv(r.stdout), available: true, engine: 'native' };
      } catch {
        // Not installed. Fall through to the bundled WASM engine.
      }
      return await ocrWithWasm(prepared);
    } finally {
      if (prepared !== imagePath) await rm(prepared, { force: true });
    }
  }

  async cleanup(paths: string[]): Promise<void> {
    await Promise.allSettled(paths.map((p) => rm(p, { force: true })));
  }
}

// --- OCR ---------------------------------------------------------------------
//
// Two engines behind one seam. The native `tesseract` binary is preferred when
// present; otherwise a WASM build answers, which is what makes OCR work on the
// hosted server at all -- tesseract is not in the Amazon Linux 2023 repos and
// EPEL is unsupported there, so the hosted image could never install it and
// verify_design_text returned "unknown" for every design.
//
// Language data is bundled next to the code rather than fetched: tesseract.js
// otherwise downloads it from a CDN on first use, which in Lambda means a
// multi-megabyte network round trip on a cold start that can simply fail.

/** Bundled tesseract language data. Mirrors the python/ layout so the hosted
 *  image can COPY it to the same relative path. */
const TESSDATA_DIR = fileURLToPath(new URL('../../tessdata', import.meta.url));

/** tesseract TSV columns; word rows are level 5. */
const TSV_LEVEL_WORD = '5';
const TSV_COL = { level: 0, block: 2, par: 3, line: 4, conf: 10, text: 11 } as const;

/** Reconstruct text and mean word confidence from tesseract's TSV output.
 *
 *  Exported for tests: the confidence number is the whole reason we ask for TSV
 *  instead of plain text, so it needs to be verifiable without a tesseract
 *  install.
 */
export function parseTesseractTsv(tsv: string): { text: string; confidence: number | null } {
  const rows = tsv.split('\n').slice(1); // drop header
  const lines = new Map<string, string[]>();
  const confidences: number[] = [];

  for (const row of rows) {
    const cells = row.split('\t');
    if (cells[TSV_COL.level] !== TSV_LEVEL_WORD) continue;
    const word = (cells[TSV_COL.text] ?? '').trim();
    if (!word) continue;

    const key = `${cells[TSV_COL.block]}/${cells[TSV_COL.par]}/${cells[TSV_COL.line]}`;
    const bucket = lines.get(key);
    if (bucket) bucket.push(word);
    else lines.set(key, [word]);

    // -1 means "no confidence reported"; averaging it in would drag the score
    // toward a failure that did not happen.
    const conf = Number(cells[TSV_COL.conf]);
    if (Number.isFinite(conf) && conf >= 0) confidences.push(conf);
  }

  const text = [...lines.values()].map((words) => words.join(' ')).join('\n');
  const confidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : null;
  return { text, confidence };
}

/** Flatten a transparent design onto a contrasting background for OCR.
 *
 *  Returns a temp path to flatten, or the ORIGINAL path when no preparation
 *  happened (already opaque, or Python/Pillow unavailable). Best-effort by
 *  design: a failure here should cost accuracy, never the whole read.
 */
async function prepareForOcr(imagePath: string): Promise<string> {
  // A single temp FILE rather than a temp dir, so the caller's one rm() of the
  // returned path leaves nothing behind.
  const out = join(tmpdir(), `ah-ocr-${randomUUID()}.png`);
  try {
    const r = await run(PYTHON, [OCR_PREP, imagePath, out]);
    if (r.code === 0) {
      const meta = JSON.parse(r.stdout.trim() || '{}') as { prepared?: boolean };
      if (meta.prepared) return out;
    }
    await rm(out, { force: true });
  } catch {
    // No python, no Pillow, unparseable output -- OCR the original.
  }
  return imagePath;
}

/** OCR via the bundled WASM engine. Absence of the package is not an error --
 *  it is the documented "OCR unavailable" state the caller already handles. */
async function ocrWithWasm(imagePath: string): Promise<OcrResult> {
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng', 1, {
      langPath: TESSDATA_DIR,
      gzip: false, // we ship the plain .traineddata, not the gzipped CDN form
      cachePath: join(tmpdir(), 'tesseract-cache'), // Lambda: only /tmp is writable
      logger: () => {},
    });
    try {
      const { data } = await worker.recognize(imagePath);
      const text = (data.text ?? '').trim();
      const confidence = typeof data.confidence === 'number' ? data.confidence : null;
      return { available: true, text, confidence, engine: 'wasm' };
    } finally {
      await worker.terminate();
    }
  } catch {
    // Neither engine is present (or the WASM worker could not start).
    return { available: false, text: '', confidence: null };
  }
}
