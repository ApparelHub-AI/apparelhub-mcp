import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
import { scanText } from '../knowledge/compliance.js';
import { resolveImageUrl } from './design.js';
import type { ImageStats, MockupStats } from '../image/imaging.js';

// Safety / compliance tools (tool spec §7). verify_design_quality is the objective, local QC gate
// (transparency correctness, resolution, premultiply, detected text); check_design_compliance is
// an advisory text-level heuristic with a clear disclaimer.

export interface QualityIssue {
  severity: 'block' | 'warn';
  // 'render' and 'background' are mockup-side categories (see scoreMockup);
  // the rest are design-side (scoreQuality).
  category:
    | 'text_spelling'
    | 'transparency'
    | 'contrast'
    | 'framing'
    | 'resolution'
    | 'render'
    | 'background';
  finding: string;
  suggested_fix?: string;
}

/** Pure scoring so it can be unit-tested + reused (e.g. by a future ship_product pre-flight). */
export function scoreQuality(
  stats: ImageStats,
  opts: { needs_transparency?: boolean; ocrText?: string } = {},
): { quality_score: number; issues: QualityIssue[] } {
  const issues: QualityIssue[] = [];
  let score = 100;
  const needsTransparency = opts.needs_transparency ?? true;

  if (needsTransparency) {
    if (!stats.has_alpha) {
      issues.push({
        severity: 'block',
        category: 'transparency',
        finding: 'Image has no alpha channel (background not removed).',
        suggested_fix: 'Run process_transparency before creating the product.',
      });
      score -= 40;
    } else {
      if (!stats.corner_alpha.every((a) => a === 0)) {
        issues.push({
          severity: 'warn',
          category: 'transparency',
          finding: 'Corners are not fully transparent (possible background residue).',
          suggested_fix: 'Re-key with process_transparency.',
        });
        score -= 15;
      }
      if (stats.transparent_ratio < 0.02) {
        issues.push({
          severity: 'warn',
          category: 'transparency',
          finding: 'Very little of the image is transparent; the background may still be present.',
        });
        score -= 15;
      }
      if (!stats.premultiplied_white) {
        issues.push({
          severity: 'warn',
          category: 'transparency',
          finding: 'Transparent pixels are not white-premultiplied (risk of a dark halo on Printful).',
          suggested_fix: 'Re-run process_transparency (it white-premultiplies).',
        });
        score -= 10;
      }
    }
  }

  const minDim = Math.min(stats.width, stats.height);
  if (minDim < 1000) {
    // Low resolution is a WARN, never a hard BLOCK: the build pipeline auto-upscales a low-res
    // design to the print-area resolution (process_transparency restores a floor after its tight
    // crop; ship_product's placed path upscales to the print area), so a low-res design must NOT
    // make an unattended run SKIP the item — that left the NORWAY passport wallet (847x596 after
    // keying) permanently unbuilt at the QC gate. The warn still surfaces it (regenerate the
    // source for genuine large-format detail); the score penalty scales with how low it is.
    const veryLow = minDim < 600;
    issues.push({
      severity: 'warn',
      category: 'resolution',
      finding: `Low resolution (${stats.width}x${stats.height}); the pipeline will upscale it to the print area, but regenerate the source at 1024px+ for sharp large-format detail.`,
      suggested_fix: 'Regenerate the design at 1024px or larger (the pipeline upscales meanwhile).',
    });
    score -= veryLow ? 20 : 10;
  }

  if (opts.ocrText && opts.ocrText.trim()) {
    issues.push({
      severity: 'warn',
      category: 'text_spelling',
      finding: `Text detected: "${opts.ocrText.trim().slice(0, 80)}". Confirm the spelling is correct.`,
      suggested_fix: 'Visually verify the text, or use verify_design_text with expected_text.',
    });
  }

  return { quality_score: Math.max(0, score), issues };
}

export const verifyDesignQuality = defineTool({
  name: 'verify_design_quality',
  description:
    'Local QC gate for a design: transparency correctness (alpha, clean corners, white premultiply), resolution, and detected text. Returns a 0-100 score + issues. Needs local Python + Pillow.',
  inputSchema: z.object({
    design_uuid: z.string().min(1),
    image_url: z.string().url().optional(),
    needs_transparency: z.boolean().optional().describe('Default true; set false for all-over-print.'),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const url = input.image_url ?? (await resolveImageUrl(ctx, input.design_uuid, input.workspace));
    const p = await ctx.imaging.downloadToTemp(url);
    const stats = await ctx.imaging.imageStats(p);
    const ocr = await ctx.imaging.ocr(p);
    await ctx.imaging.cleanup([p]);
    if (!stats) {
      throw new AhError({
        code: 'local_tool_unavailable',
        message: 'Quality checks need local Python + Pillow, which is not available.',
        suggestion: 'Install it (`pip3 install Pillow`), or run the QC in the ApparelHub web app.',
      });
    }
    const { quality_score, issues } = scoreQuality(stats, {
      needs_transparency: input.needs_transparency,
      ocrText: ocr.available ? ocr.text : undefined,
    });
    return {
      quality_score,
      issues,
      dimensions: { width: stats.width, height: stats.height },
      transparency: {
        has_alpha: stats.has_alpha,
        corners_clean: stats.corner_alpha.every((a) => a === 0),
        premultiplied_white: stats.premultiplied_white,
      },
    };
  },
});

export const checkDesignCompliance = defineTool({
  name: 'check_design_compliance',
  description:
    'Advisory pre-flight for IP / trademark / prohibited-content risk. Scans the prompt/name and any detected text against common protected marks. NOT legal advice, and NOT an image-content trademark check.',
  inputSchema: z.object({
    design_uuid: z.string().optional(),
    image_url: z.string().url().optional(),
    prompt: z.string().optional().describe('The prompt that produced the design (scanned for risk terms).'),
    name: z.string().optional().describe('The intended product name (scanned).'),
    target_channels: z.array(z.string()).optional(),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const parts = [input.prompt, input.name].filter(Boolean) as string[];

    // Best-effort: OCR the design too, if we can reach it.
    if (input.image_url || input.design_uuid) {
      try {
        const url =
          input.image_url ?? (await resolveImageUrl(ctx, input.design_uuid as string, input.workspace));
        const p = await ctx.imaging.downloadToTemp(url);
        const ocr = await ctx.imaging.ocr(p);
        await ctx.imaging.cleanup([p]);
        if (ocr.available && ocr.text.trim()) parts.push(ocr.text);
      } catch {
        // OCR is best-effort; a failure just means we scan the provided text only.
      }
    }

    const flags = scanText(parts.join(' '), input.target_channels ?? []);
    const blocked = flags.some((f) => f.severity === 'block');
    const recommendation = blocked ? 'regenerate' : flags.length ? 'review_required' : 'approve';
    return {
      approved: !blocked,
      flags,
      recommendation,
      disclaimer:
        'Advisory only, not legal advice. This is a text-level heuristic (prompt/name + any detected text); it does not analyze image content for trademarks. Consult a professional for IP decisions.',
    };
  },
});


// ---------------------------------------------------------------------------
// Mockup QC (epic phase 5)
//
// verify_design_quality checks the DESIGN. This checks the RENDER: the design
// can be perfect and the composition onto the garment still wrong, which is
// where placement defects actually appear.
//
// Scope is deliberately narrow, and the reason is worth stating. Three signals
// were validated against real renders and separate cleanly, so they are graded
// here as verdicts:
//
//   chroma leak      0.19 on an unkeyed green screen vs 0.00 on a normal print
//   empty render     unambiguous
//   resolution       unambiguous
//
// A fourth, "how much of the garment is actually printed", was built and then
// REJECTED. Measured against the all-over-print tee that shipped with bare
// sleeves and a bare hem, it scored 0.55, while a correct chest print scored
// 0.62. It does not separate the case it was built for, because fabric shading
// and folds read as design. Shipping it as a verdict would produce confident
// wrong answers on the exact defect this tool exists to catch.
//
// So the coverage numbers are returned as measurements, clearly unjudged, and
// the perceptual checklist items (coverage, rotation, seam splits) are handed
// back for the caller to judge by LOOKING at the render. The value delivered is
// that the rubric and the hard checks are identical for every caller, instead
// of each harness inventing its own.
// ---------------------------------------------------------------------------

/** Perceptual items no pixel statistic decides reliably. Fixed wording so two
 *  callers grading the same render answer the same questions. */
export const MOCKUP_VISUAL_CHECKLIST = [
  'Is the design UPRIGHT (not rotated or inverted)?',
  'Is any content CLIPPED at an edge of the print area?',
  'Is the subject SPLIT by a seam or fold?',
  'Is EVERY printable face covered, with no blank panel? On an all-over-print garment check the SLEEVES and the BOTTOM HEM specifically, since those are where a mis-routed chest composition leaves bare fabric.',
  'Does the print sit correctly on the product (fill goods edge to edge, placed goods on bare product)?',
];

export function scoreMockup(stats: MockupStats): {
  quality_score: number;
  issues: QualityIssue[];
} {
  const issues: QualityIssue[] = [];
  let score = 100;

  if (stats.empty || stats.garment_ratio < 0.02) {
    issues.push({
      severity: 'block',
      category: 'render',
      finding: 'The render is empty: no product is visible in the frame.',
      suggested_fix: 'Re-generate the mockup; if it repeats, the preview job failed upstream.',
    });
    return { quality_score: 0, issues };
  }

  if (stats.chroma_green_ratio > 0.02) {
    issues.push({
      severity: 'block',
      category: 'background',
      finding: `Chroma-key green reached the product (${(stats.chroma_green_ratio * 100).toFixed(1)}% of the garment). The design was printed with its green screen still attached.`,
      suggested_fix: 'Run process_transparency on the design and re-generate the mockup.',
    });
    score -= 60;
  }

  if (stats.min_dimension < 400) {
    issues.push({
      severity: 'warn',
      category: 'resolution',
      finding: `Render is only ${stats.width}x${stats.height}; too small to judge print placement.`,
      suggested_fix: 'Request a larger preview before grading.',
    });
    score -= 20;
  }

  return { quality_score: Math.max(0, score), issues };
}

export const verifyMockupQuality = defineTool({
  name: 'verify_mockup_quality',
  description:
    'QC gate for a rendered product MOCKUP (verify_design_quality checks the design; this checks the render on the garment). ' +
    'Deterministically catches three defects that have actually shipped: an un-keyed chroma-green background printed onto the product, an empty render, and a render too small to judge. ' +
    'It does NOT decide whether the design is upright, clipped, seam-split, or whether every face is printed: those need looking at the image, and a pixel statistic that guessed would be confidently wrong on exactly those cases. ' +
    'It returns a fixed visual_checklist for you to answer by VIEWING the render, so grading is consistent across callers. ' +
    'Treat a clean result as "no hard defect found", not "the mockup is good" until you have answered the checklist.',
  inputSchema: z.object({
    preview_url: z.string().url().describe('URL of the rendered mockup to grade.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const p = await ctx.imaging.downloadToTemp(input.preview_url);
    const stats = await ctx.imaging.mockupStats(p);
    await ctx.imaging.cleanup([p]);
    if (!stats) {
      throw new AhError({
        code: 'local_tool_unavailable',
        message: 'Mockup checks need local Python + Pillow, which is not available.',
        suggestion: 'Install it (`pip3 install Pillow`), or grade the render visually.',
      });
    }
    const { quality_score, issues } = scoreMockup(stats);
    return {
      quality_score,
      verdict: issues.some((i) => i.severity === 'block') ? 'block' : issues.length ? 'warn' : 'no_hard_defect',
      issues,
      visual_checklist: MOCKUP_VISUAL_CHECKLIST,
      // Returned as measurements, NOT graded. Validation showed these do not
      // reliably separate a correctly printed garment from a half-printed one
      // (0.62 correct vs 0.55 broken), so they inform a human or vision pass
      // rather than producing a verdict.
      measurements: {
        design_coverage: stats.design_coverage,
        largest_flat_run: stats.largest_flat_run,
        garment_ratio: stats.garment_ratio,
        distinct_colors: stats.distinct_colors,
        note: 'Unjudged. design_coverage does not reliably distinguish a fully printed garment from a partly printed one; answer the visual_checklist by looking at the render.',
      },
    };
  },
});

export const safetyTools: ToolDef[] = [verifyDesignQuality, checkDesignCompliance, verifyMockupQuality];
