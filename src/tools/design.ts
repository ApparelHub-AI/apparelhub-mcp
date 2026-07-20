import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
import { asArray, isRecord, str } from '../util/shape.js';
import { runGenerationWithFallback } from '../image/generate.js';
import {
  augmentPromptForTransparency,
  buildIterationPrompt,
  EDIT_CAPABLE_SOURCES,
  fallbackLadder,
  normalizeSource,
} from '../knowledge/sources.js';
import type { ToolContext } from './context.js';

// Design workflows (tool spec §2 + §3.5). design_apparel is the atomic workflow (generate ->
// key transparency -> optional text check); generate_image / process_transparency /
// verify_design_text are the composable split primitives. The transparency + OCR steps run
// locally (spec §0); when the local toolchain is missing they degrade with a clear notice.

const sizeEnum = z.enum(['1024x1024', '1024x1792', '1792x1024']);
const styleEnum = z.enum(['photoreal', 'vector', 'abstract', 'auto']);

// Min long-side a keyed design is upscaled back to after the tight crop, so it clears the QC
// gate's low-resolution threshold (min side < 600 = block, < 1000 = warn) for typical aspects and
// matches ship_product's placed-path floor (so no double upscale). See processTransparencyImpl.
const RESOLUTION_FLOOR = 2000;

export async function resolveImageUrl(
  ctx: ToolContext,
  imageUuid: string,
  workspace?: string,
): Promise<string> {
  const raw = await ctx.api.get('images/generated', {
    query: { limit: 100 },
    workspace,
    signal: ctx.signal,
  });
  for (const img of asArray(raw, 'images', 'generated', 'designs')) {
    const uuid = str(img, 'uuid', 'design_uuid', 'id');
    if (uuid === imageUuid) {
      const url = str(img, 'url', 'full_url', 'image_url');
      if (url) return url;
    }
  }
  throw new AhError({
    code: 'not_found',
    message: `Could not resolve a URL for image ${imageUuid}.`,
    suggestion: 'Pass image_url explicitly, or verify the image_uuid with list_my_designs.',
  });
}

interface TransparencyOutcome {
  image_uuid: string;
  image_url: string;
  has_true_alpha: boolean;
  premultiplied_white: boolean;
  corners_clean: boolean;
  keying_mode: 'box' | 'dominance';
  note?: string;
}

interface TransparencyOptions {
  mode?: 'box' | 'dominance';
  force?: boolean;
}

async function processTransparencyImpl(
  ctx: ToolContext,
  imageUuid: string,
  imageUrl: string | undefined,
  workspace: string | undefined,
  opts: TransparencyOptions = {},
): Promise<TransparencyOutcome> {
  const url = imageUrl ?? (await resolveImageUrl(ctx, imageUuid, workspace));
  await ctx.progress.report(25, 'Downloading design...');
  const inPath = await ctx.imaging.downloadToTemp(url);
  await ctx.progress.report(50, 'Keying background to transparency...');

  let keyingMode: 'box' | 'dominance' = opts.mode ?? 'box';
  let note: string | undefined;
  let t;
  try {
    t = await ctx.imaging.makeTransparent(inPath, { mode: keyingMode, force: opts.force });
  } catch (err) {
    // Self-heal the single most common failure: the AI produced a tinted / muted green (not pure
    // #00FF00), so the box keyer's sanity check refused it. Green-DOMINANCE keying strips a tinted
    // green screen safely — it only clears pixels where green clearly outweighs red AND blue, so
    // charcoal / white / warm art is preserved. Only auto-fall-back when the caller didn't pin a
    // mode or force (respect an explicit choice). This keeps an unattended run from dead-ending.
    if (
      err instanceof AhError &&
      err.code === 'chroma_background' &&
      opts.mode === undefined &&
      !opts.force
    ) {
      keyingMode = 'dominance';
      note =
        'The generator produced a tinted/muted green background (not pure #00FF00), so the standard keyer was blocked. Re-keyed in green-dominance mode, which strips a tinted green screen safely. If the design contains intentionally bright-green or lime elements, verify they were not affected (verify_design_quality).';
      await ctx.progress.report(55, 'Tinted background — re-keying in dominance mode...');
      t = await ctx.imaging.makeTransparent(inPath, { mode: 'dominance' });
    } else {
      await ctx.imaging.cleanup([inPath]);
      throw err;
    }
  }

  // Resolution floor after keying: the flood-fill + tight-crop can shrink a design below the QC
  // gate's low-resolution threshold (a 1024x1024 design keyed + cropped to its artwork bbox came
  // out 847x596 — min side 596 < 600, which made verify_design_quality BLOCK and an unattended run
  // SKIP the NORWAY passport wallet forever). Upscale the keyed result to a usable floor (Lanczos,
  // white-premultiplied) so QC passes and the design is print-ready; ship_product bumps it further
  // for large print areas. No-op + no extra work when the crop stayed large enough.
  const outPaths = [inPath, t.outputPath];
  let keyedPath = t.outputPath;
  try {
    const hi = await ctx.imaging.ensureResolution(t.outputPath, RESOLUTION_FLOOR);
    if (hi.upscaled) {
      keyedPath = hi.outputPath;
      outPaths.push(hi.outputPath);
    }
  } catch {
    // A resolution upscale is best-effort — never fail transparency over it; ship_product's
    // placed-path resolution net is the backstop.
  }

  await ctx.progress.report(80, 'Uploading transparent design...');
  const bytes = await ctx.imaging.readBytes(keyedPath);
  const form = new FormData();
  // Uint8Array.from gives an ArrayBuffer-backed view (a valid BlobPart under TS 6's narrowed types).
  form.append('image', new Blob([Uint8Array.from(bytes)], { type: 'image/png' }), 'transparent.png');
  const res = await ctx.api.post(`images/generated/${encodeURIComponent(imageUuid)}/transform`, {
    multipart: form,
    workspace,
    signal: ctx.signal,
  });
  await ctx.imaging.cleanup(outPaths);
  await ctx.progress.report(100, 'Transparency complete.');
  return {
    image_uuid: str(res, 'image_uuid', 'uuid') ?? imageUuid,
    image_url: str(res, 'url', 'image_url') ?? url,
    has_true_alpha: true,
    premultiplied_white: true,
    corners_clean: t.cornersClean,
    keying_mode: keyingMode,
    ...(note ? { note } : {}),
  };
}

interface TextOutcome {
  has_text: boolean;
  detected_text: string;
  spelled_correctly: boolean | null;
  confidence: number;
  note?: string;
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function verifyTextImpl(
  ctx: ToolContext,
  imageUuid: string,
  imageUrl: string | undefined,
  expectedText: string | undefined,
  workspace: string | undefined,
): Promise<TextOutcome> {
  const url = imageUrl ?? (await resolveImageUrl(ctx, imageUuid, workspace));
  const p = await ctx.imaging.downloadToTemp(url);
  const ocr = await ctx.imaging.ocr(p);
  await ctx.imaging.cleanup([p]);
  const detected = ocr.text;
  const hasText = normalizeText(detected).length > 0;

  if (!ocr.available) {
    return {
      has_text: hasText,
      detected_text: detected,
      spelled_correctly: null,
      confidence: 0,
      note: 'Local OCR (tesseract) is not installed, so text could not be read here. Install tesseract, or have the calling agent visually verify the spelling from the design image.',
    };
  }
  let spelledCorrectly: boolean | null = null;
  let note: string | undefined;
  if (expectedText) {
    spelledCorrectly = normalizeText(detected).includes(normalizeText(expectedText));
  } else if (hasText) {
    note = 'No expected_text provided; detected text is returned for the agent to verify.';
  }
  return { has_text: hasText, detected_text: detected, spelled_correctly: spelledCorrectly, confidence: 0.7, note };
}

// --- Split primitives ---

export const generateImage = defineTool({
  name: 'generate_image',
  description:
    'Generate a design image (split primitive of design_apparel). Returns the raw generated image; follow with process_transparency for apparel that needs a transparent background. Rate-limit errors are classified (model_rate_limited = one model\'s provider vs platform_rate_limited = this key\'s ApparelHub throttle vs request_not_sent = the call never reached ApparelHub), and fallback_trail shows any model substitutions.',
  inputSchema: z.object({
    prompt: z.string().min(1),
    source: z
      .string()
      .optional()
      .describe('Explicit model name, or omit to auto-pick (Nano Banana; OpenAI for abstract).'),
    size: sizeEnum
      .optional()
      .describe(
        'Output shape. 1024x1024 = square; 1024x1792 = tall/portrait (phone cases, posters, banners); 1792x1024 = wide/landscape (mugs, laptop sleeves, wide banners). Pick to match the product\'s print area — full-bleed goods like phone cases want a tall design that fills the whole area, or the mockup pads/crops it. To re-shape an EXISTING design without spending another generation, use fit_aspect instead.',
      ),
    style: styleEnum.optional(),
    augment_prompt_for_transparency: z
      .boolean()
      .optional()
      .describe('Add the solid-green-background hint so the background can be keyed out (default true).'),
    no_fallback: z
      .boolean()
      .optional()
      .describe(
        'Disable the model-fallback ladder. By default a rate-limited/transient model transparently retries with a different model (see fallback_trail); set true to fail on the chosen source alone.',
      ),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const augment = input.augment_prompt_for_transparency ?? true;
    const prompt = augment ? augmentPromptForTransparency(input.prompt) : input.prompt;
    // Normalize a near-miss source (case/spelling) to its canonical name, or reject it clearly (#70).
    const source = input.source !== undefined ? normalizeSource(input.source) : undefined;
    const sources = fallbackLadder({ style: input.style, source });
    const started = Date.now();
    const g = await runGenerationWithFallback(
      ctx.api,
      { prompt, source: sources[0]!, sources, size: input.size, workspace: input.workspace, noFallback: input.no_fallback },
      { progress: ctx.progress, signal: ctx.signal },
    );
    return {
      image_uuid: g.image_uuid,
      image_url: g.image_url,
      source_used: g.source_used,
      fallback_trail: g.fallback_trail,
      generation_latency_ms: Date.now() - started,
    };
  },
});

export const processTransparency = defineTool({
  name: 'process_transparency',
  description:
    'Key a solid background out of a generated image to true RGBA transparency (flood-fill + enclosed-region sweep + tight crop) and upload the result. Runs server-side (Python + Pillow). If the generator produced a tinted/muted green instead of pure #00FF00, it auto-recovers by re-keying in green-dominance mode (safe for art with no bright-green/lime elements). Returns a NEW image_uuid plus keying_mode.',
  inputSchema: z.object({
    image_uuid: z.string().min(1),
    image_url: z.string().url().optional().describe('The image URL, if known (else resolved from the uuid).'),
    background_mode: z
      .enum(['auto', 'box', 'dominance'])
      .optional()
      .describe(
        'How to detect the background. auto (default): box-key a pure-green screen, else auto-recover in dominance mode for a tinted/muted green. box: strict pure-#00FF00 keying (best for colorful designs with warm/lime elements). dominance: green-dominance keying, robust to tinted green screens (safe when the design has no bright-green/lime elements).',
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        'Bypass the pure-green safety check and box-key anyway. Use only when you have visually confirmed the palette has no colors near the green background.',
      ),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const mode = input.background_mode === 'auto' ? undefined : input.background_mode;
    return processTransparencyImpl(ctx, input.image_uuid, input.image_url, input.workspace, {
      mode,
      force: input.force,
    });
  },
});

export const verifyDesignText = defineTool({
  name: 'verify_design_text',
  description:
    'Read the text in a design with local OCR (tesseract) when available, so the agent can confirm spelling. Advisory: pass expected_text to get a match verdict, otherwise the detected text is returned for visual review.',
  inputSchema: z.object({
    image_uuid: z.string().min(1),
    image_url: z.string().url().optional(),
    expected_text: z.string().optional(),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    verifyTextImpl(ctx, input.image_uuid, input.image_url, input.expected_text, input.workspace),
});

// --- Atomic workflows ---

export const designApparel = defineTool({
  name: 'design_apparel',
  description:
    'End-to-end apparel design with the platform lessons baked in: solid-green-background prompt, transparency keying, and (optionally) a local text check. Returns ready-to-use design(s). Streams progress. Set needs_transparency=false for all-over-print products. Rate-limit errors are classified (model_rate_limited = one model\'s provider vs platform_rate_limited = this key\'s ApparelHub throttle vs request_not_sent = the call never reached ApparelHub), and each design\'s fallback_trail shows any model substitutions.',
  inputSchema: z.object({
    prompt: z.string().min(1),
    count: z.number().int().positive().max(4).optional(),
    garment_type: z.string().optional().describe('Hints source selection.'),
    style: styleEnum.optional(),
    needs_transparency: z.boolean().optional(),
    verify_text: z.boolean().optional(),
    source: z.string().optional(),
    no_fallback: z
      .boolean()
      .optional()
      .describe(
        'Disable the model-fallback ladder. By default a rate-limited/transient model transparently retries with a different model (per-design fallback_trail); set true to fail on the chosen source alone.',
      ),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const count = input.count ?? 1;
    const needsTransparency = input.needs_transparency ?? true;
    const verifyText = input.verify_text ?? true;
    // Normalize a near-miss source (case/spelling) to its canonical name, or reject it clearly (#70).
    const source = input.source !== undefined ? normalizeSource(input.source) : undefined;
    const sources = fallbackLadder({ style: input.style, source });
    const designs: Record<string, unknown>[] = [];

    for (let i = 0; i < count; i += 1) {
      await ctx.progress.report(Math.round((i / count) * 100), `Design ${i + 1} of ${count}...`);
      const prompt = augmentPromptForTransparency(input.prompt);
      const gen = await runGenerationWithFallback(
        ctx.api,
        { prompt, source: sources[0]!, sources, workspace: input.workspace, noFallback: input.no_fallback },
        { progress: ctx.progress, signal: ctx.signal },
      );

      const design: Record<string, unknown> = {
        design_uuid: gen.image_uuid,
        design_url: gen.image_url,
        source_used: gen.source_used,
        fallback_trail: gen.fallback_trail,
        transparency_clean: false,
      };

      if (needsTransparency) {
        try {
          const t = await processTransparencyImpl(ctx, gen.image_uuid, gen.image_url, input.workspace);
          design.design_uuid = t.image_uuid;
          design.design_url = t.image_url;
          design.transparency_clean = t.corners_clean;
          design.keying_mode = t.keying_mode;
          if (t.note) design.transparency_note = t.note;
        } catch (err) {
          // Never abort an otherwise-good design over the keying step in an unattended run.
          // process_transparency already auto-recovers a tinted-green background (dominance mode),
          // so reaching here means the keyer genuinely couldn't finish (missing toolchain, or a
          // hard keyer failure) — keep the raw design + a clear flag so the pipeline continues and
          // the agent can decide. Transient / auth errors (platform_rate_limited,
          // upstream_unavailable, auth_required, download_failed, ...) still surface so a
          // scheduled run RETRIES rather than silently shipping an unkeyed design.
          const degradable =
            err instanceof AhError &&
            (err.code === 'local_tool_unavailable' || err.code === 'transparency_failed');
          if (degradable) {
            const e = err as AhError;
            design.transparency_clean = false;
            design.keying_mode = 'box';
            design.warning = `Transparency not applied (${e.code}): ${e.message} ${e.suggestion ?? ''}`.trim();
          } else {
            throw err;
          }
        }
      }

      if (verifyText) {
        const v = await verifyTextImpl(
          ctx,
          String(design.design_uuid),
          String(design.design_url),
          undefined,
          input.workspace,
        );
        design.text_verified = {
          has_text: v.has_text,
          detected_text: v.detected_text,
          spelled_correctly: v.spelled_correctly,
        };
      }

      designs.push(design);
    }

    await ctx.progress.report(100, 'Done.');
    return { designs };
  },
});

export const iterateDesign = defineTool({
  name: 'iterate_design',
  description:
    'Generate a variation of an existing design via img2img (e.g. "make the cactus blue"). Almost every source supports editing; only Google Imagen 4 is text-to-image-only (rejected). Multi-reference edits (several source images) work on Seedream, Flux 2 Pro, and Wan; slow-model edits return 202 and are polled automatically.',
  inputSchema: z.object({
    source_design_uuid: z.string().min(1),
    change_description: z.string().min(1),
    preserve: z.array(z.enum(['composition', 'subject', 'style'])).optional(),
    source: z.string().optional().describe('Editing source (default Nano Banana).'),
    no_fallback: z
      .boolean()
      .optional()
      .describe(
        'Disable the model-fallback ladder. By default a rate-limited/transient editing model transparently retries with another edit-capable model (see fallback_trail); set true to fail on the chosen source alone.',
      ),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    // Normalize a near-miss source (case/spelling) to its canonical name, or reject it clearly (#70).
    const source = normalizeSource(input.source ?? 'Nano Banana');
    // Almost every source can edit; only a text-to-image-only source (Google Imagen 4) is a hard
    // error, not a silent switch, so the user learns their choice is invalid for editing.
    if (!EDIT_CAPABLE_SOURCES.has(source)) {
      throw new AhError({
        code: 'unprocessable',
        message: `Source "${source}" is text-to-image only and cannot edit. Pick any other source (e.g. Nano Banana, Seedream, Flux).`,
      });
    }
    const preserve = input.preserve ?? ['composition', 'subject'];
    const prompt = buildIterationPrompt(input.change_description, preserve);
    // Edit-only ladder: the two edit-capable models, chosen source first.
    const sources = fallbackLadder({ source, edit: true });
    const g = await runGenerationWithFallback(
      ctx.api,
      {
        prompt,
        source: sources[0]!,
        sources,
        sourceImageUuid: input.source_design_uuid,
        workspace: input.workspace,
        noFallback: input.no_fallback,
      },
      { progress: ctx.progress, signal: ctx.signal },
    );
    return {
      design_uuid: g.image_uuid,
      design_url: g.image_url,
      source_used: g.source_used,
      fallback_trail: g.fallback_trail,
    };
  },
});

// Common aspect ratios for print-on-demand goods. A plain string is also accepted (the platform
// validates "W:H"), but the enum steers the agent to the shapes real products need.
const aspectEnum = z.enum(['1:1', '9:16', '16:9', '4:5', '3:4', '4:3', '2:3', '3:2']);

export const fitAspect = defineTool({
  name: 'fit_aspect',
  description:
    'Fit an EXISTING design image to a target aspect ratio without generating a new one. mode="pad" letterboxes it onto a background (keeps the whole design, nothing cropped); mode="crop" center-crops (trims the edges to fill the shape). QUOTA-FREE: this reshapes an existing image and does NOT consume an image-generation credit. Use to adapt a square design to a product\'s print area (e.g. a tall 9:16 for a phone case or poster, a wide 16:9 for a mug or banner). Returns a NEW design (image uuid + url). Note: for an AI-generated EXTENSION of the borders (outpainting) instead of a flat pad/crop, generate a new image with generate_image at the target size — that DOES use the image-generation quota.',
  inputSchema: z.object({
    image_uuid: z.string().min(1).describe('The uuid of an existing design to reshape (from generate_image / list_my_designs).'),
    aspect: z
      .union([aspectEnum, z.string().regex(/^\d+:\d+$/, 'Use "W:H", e.g. "9:16".')])
      .describe('Target aspect ratio as "W:H". Common: 9:16 tall (phone cases, posters), 16:9 wide (mugs, banners), 1:1 square, 4:5 portrait.'),
    mode: z
      .enum(['pad', 'crop'])
      .default('pad')
      .describe('pad (default): letterbox onto a background, keeping the whole design (nothing lost). crop: center-crop to fill the shape, trimming the edges.'),
    background: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB hex color, e.g. "#FFFFFF".')
      .optional()
      .describe('Fill color for the padded bars as #RRGGBB (pad mode only; ignored for crop). Defaults to transparent/white on the platform when omitted.'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    // Default in the handler body (not only via the zod .default) so the mode is correct whether
    // called through the registry's safeParse dispatch or directly — matches the repo's pattern of
    // resolving defaults in-handler (e.g. augment_prompt_for_transparency ?? true).
    const mode = input.mode ?? 'pad';
    const res = await ctx.api.post(
      `images/generated/${encodeURIComponent(input.image_uuid)}/fit-aspect`,
      {
        body: {
          aspect: input.aspect,
          mode,
          ...(input.background ? { background: input.background } : {}),
        },
        workspace: input.workspace,
        signal: ctx.signal,
      },
    );
    // The route returns { image: { uuid, url, title, created }, source_image_uuid, aspect, mode, dimensions }.
    const image = isRecord(res) && isRecord(res.image) ? res.image : res;
    return {
      image_uuid: str(image, 'uuid', 'image_uuid', 'id'),
      image_url: str(image, 'url', 'image_url', 'full_url'),
      source_image_uuid: str(res, 'source_image_uuid') ?? input.image_uuid,
      aspect: str(res, 'aspect') ?? input.aspect,
      mode: str(res, 'mode') ?? mode,
      dimensions: isRecord(res) ? res.dimensions : undefined,
    };
  },
});

export const designTools: ToolDef[] = [
  generateImage,
  processTransparency,
  verifyDesignText,
  designApparel,
  iterateDesign,
  fitAspect,
];
