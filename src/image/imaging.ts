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
const PYTHON = process.env.APPARELHUB_MCP_PYTHON || 'python3';

export interface TransparencyResult {
  outputPath: string;
  /** true when all four corners keyed fully transparent (make_transparent exit 0). */
  cornersClean: boolean;
  width?: number;
  height?: number;
}

export interface Imaging {
  downloadToTemp(url: string, ext?: string): Promise<string>;
  makeTransparent(inputPath: string): Promise<TransparencyResult>;
  readBytes(path: string): Promise<Uint8Array>;
  imageSize(path: string): Promise<{ width: number; height: number } | undefined>;
  ocr(imagePath: string): Promise<{ available: boolean; text: string }>;
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

  async makeTransparent(inputPath: string): Promise<TransparencyResult> {
    const out = join(await this.dir(), `t-${Date.now()}.png`);
    let r: RunResult;
    try {
      r = await run(PYTHON, [MAKE_TRANSPARENT, inputPath, out]);
    } catch {
      throw pythonMissing();
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
