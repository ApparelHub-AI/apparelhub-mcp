import { spawn } from 'node:child_process';
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
const THREAD_COLORS = fileURLToPath(new URL('../../python/thread_colors.py', import.meta.url));
const RECOMPOSE_FILL = fileURLToPath(new URL('../../python/recompose_fill.py', import.meta.url));
const PYTHON = process.env.APPARELHUB_MCP_PYTHON || 'python3';

export interface ImageStats {
  width: number;
  height: number;
  mode: string;
  has_alpha: boolean;
  transparent_ratio: number;
  corner_alpha: number[];
  premultiplied_white: boolean;
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
  /** Visible-face rectangle (fractions of the print area) the art must be composed within —
   *  the background still fills the whole area. Wrap-style goods (drawstring bags, sock legs). */
  face?: { x: number; y: number; w: number; h: number };
  /** Rotate the art 180deg before composing (placements that render the file inverted). */
  rotate180?: boolean;
}

export interface RecomposeFillResult {
  outputPath: string;
  /** 'composited' = art re-laid on a derived background; 'cover' = photo cover-cropped;
   *  'solid' = background-only canvas (sibling placements of all-over goods). */
  mode: 'composited' | 'cover' | 'solid';
  /** The chosen background hex (composited mode only). */
  background?: string;
  width?: number;
  height?: number;
}

export interface Imaging {
  downloadToTemp(url: string, ext?: string): Promise<string>;
  makeTransparent(inputPath: string, opts?: MakeTransparentOptions): Promise<TransparencyResult>;
  readBytes(path: string): Promise<Uint8Array>;
  imageSize(path: string): Promise<{ width: number; height: number } | undefined>;
  /** Full quality stats (alpha, transparency, premultiply). Undefined if Python/Pillow missing. */
  imageStats(path: string): Promise<ImageStats | undefined>;
  ocr(imagePath: string): Promise<{ available: boolean; text: string }>;
  /** Dominant design colors mapped to Printful's fixed embroidery thread palette (CIE Lab). */
  threadColors(inputPath: string, max?: number): Promise<string[]>;
  /**
   * Recompose a design to FILL a print face edge-to-edge at the given area aspect: keyed/green
   * art gets centered on an aesthetically matching background; opaque photos get cover-cropped.
   * `options.face` confines the art to the visible-face rectangle of a wrap-style area;
   * `options.rotate180` flips the art for placements that render the file inverted.
   */
  recomposeFill(
    inputPath: string,
    areaWidth: number,
    areaHeight: number,
    options?: RecomposeFillOptions,
  ): Promise<RecomposeFillResult>;
  /** Background-only canvas for sibling placements of all-over goods (no raw-fabric surfaces). */
  solidFill(
    inputPath: string,
    areaWidth: number,
    areaHeight: number,
    background?: string,
  ): Promise<RecomposeFillResult>;
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

  async recomposeFill(
    inputPath: string,
    areaWidth: number,
    areaHeight: number,
    options?: RecomposeFillOptions,
  ): Promise<RecomposeFillResult> {
    const out = join(await this.dir(), `fill-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
    const args = [RECOMPOSE_FILL, inputPath, out, '--aspect', `${areaWidth}:${areaHeight}`];
    const face = options?.face;
    if (face) args.push('--face', `${face.x}:${face.y}:${face.w}:${face.h}`);
    if (options?.rotate180) args.push('--rotate180');
    let r: RunResult;
    try {
      r = await run(PYTHON, args);
    } catch {
      throw pythonMissing();
    }
    if (r.code !== 0) {
      if (looksLikeMissingInterpreter(r)) throw pythonMissing();
      throw new AhError({
        code: 'recompose_failed',
        message: `Fill recompose failed: ${r.stderr.trim() || `exit ${r.code}`}`,
        suggestion:
          'Retry with print_style: "placed", or verify the design downloads and decodes correctly.',
      });
    }
    let meta: { mode?: string; background?: string | null; width?: number; height?: number } = {};
    try {
      meta = JSON.parse(r.stdout.trim()) as typeof meta;
    } catch {
      // Metadata is advisory; the output file is the contract.
    }
    return {
      outputPath: out,
      mode: meta.mode === 'cover' ? 'cover' : meta.mode === 'solid' ? 'solid' : 'composited',
      background: meta.background ?? undefined,
      width: meta.width,
      height: meta.height,
    };
  }

  /**
   * Background-only canvas at the given aspect: the fill file for SIBLING placements of an
   * all-over product (backpack top/bottom/pocket) so no printable surface is left as raw
   * fabric. `background` pins the exact hex (from the primary composition); without it the
   * color is derived from the artwork at `inputPath`.
   */
  async solidFill(
    inputPath: string,
    areaWidth: number,
    areaHeight: number,
    background?: string,
  ): Promise<RecomposeFillResult> {
    const out = join(
      await this.dir(),
      `solid-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`,
    );
    const args = [RECOMPOSE_FILL, inputPath, out, '--aspect', `${areaWidth}:${areaHeight}`, '--solid'];
    if (background) args.push('--bg', background);
    let r: RunResult;
    try {
      r = await run(PYTHON, args);
    } catch {
      throw pythonMissing();
    }
    if (r.code !== 0) {
      if (looksLikeMissingInterpreter(r)) throw pythonMissing();
      throw new AhError({
        code: 'recompose_failed',
        message: `Solid fill failed: ${r.stderr.trim() || `exit ${r.code}`}`,
        suggestion: 'Retry with print_style: "placed", or pass a background color.',
      });
    }
    let meta: { background?: string | null; width?: number; height?: number } = {};
    try {
      meta = JSON.parse(r.stdout.trim()) as typeof meta;
    } catch {
      // Metadata is advisory; the output file is the contract.
    }
    return {
      outputPath: out,
      mode: 'solid',
      background: meta.background ?? background,
      width: meta.width,
      height: meta.height,
    };
  }

  async ocr(imagePath: string): Promise<{ available: boolean; text: string }> {
    try {
      const r = await run('tesseract', [imagePath, 'stdout']);
      if (r.code !== 0) return { available: false, text: '' };
      return { available: true, text: r.stdout.trim() };
    } catch {
      // tesseract not installed -> OCR simply isn't available; caller degrades gracefully.
      return { available: false, text: '' };
    }
  }

  async cleanup(paths: string[]): Promise<void> {
    await Promise.allSettled(paths.map((p) => rm(p, { force: true })));
  }
}
