import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
import { asArray, str } from '../util/shape.js';
import { runGeneration } from '../image/generate.js';
import {
  augmentPromptForTransparency,
  buildIterationPrompt,
  EDIT_CAPABLE_SOURCES,
  pickSource,
} from '../knowledge/sources.js';
import type { ToolContext } from './context.js';

// Design workflows (tool spec §2 + §3.5). design_apparel is the atomic workflow (generate ->
// key transparency -> optional text check); generate_image / process_transparency /
// verify_design_text are the composable split primitives. The transparency + OCR steps run
// locally (spec §0); when the local toolchain is missing they degrade with a clear notice.

const sizeEnum = z.enum(['1024x1024', '1024x1792', '1792x1024']);
const styleEnum = z.enum(['photoreal', 'vector', 'abstract', 'auto']);

async function resolveImageUrl(
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
}

async function processTransparencyImpl(
  ctx: ToolContext,
  imageUuid: string,
  imageUrl: string | undefined,
  workspace: string | undefined,
): Promise<TransparencyOutcome> {
  const url = imageUrl ?? (await resolveImageUrl(ctx, imageUuid, workspace));
  await ctx.progress.report(25, 'Downloading design...');
  const inPath = await ctx.imaging.downloadToTemp(url);
  await ctx.progress.report(50, 'Keying background to transparency...');
  const t = await ctx.imaging.makeTransparent(inPath);
  await ctx.progress.report(80, 'Uploading transparent design...');
  const bytes = await ctx.imaging.readBytes(t.outputPath);
  const form = new FormData();
  // Uint8Array.from gives an ArrayBuffer-backed view (a valid BlobPart under TS 6's narrowed types).
  form.append('image', new Blob([Uint8Array.from(bytes)], { type: 'image/png' }), 'transparent.png');
  const res = await ctx.api.post(`images/generated/${encodeURIComponent(imageUuid)}/transform`, {
    multipart: form,
    workspace,
    signal: ctx.signal,
  });
  await ctx.imaging.cleanup([inPath, t.outputPath]);
  await ctx.progress.report(100, 'Transparency complete.');
  return {
    image_uuid: str(res, 'image_uuid', 'uuid') ?? imageUuid,
    image_url: str(res, 'url', 'image_url') ?? url,
    has_true_alpha: true,
    premultiplied_white: true,
    corners_clean: t.cornersClean,
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
    'Generate a design image (split primitive of design_apparel). Returns the raw generated image; follow with process_transparency for apparel that needs a transparent background.',
  inputSchema: z.object({
    prompt: z.string().min(1),
    source: z
      .string()
      .optional()
      .describe('Explicit model name, or omit to auto-pick (Nano Banana; OpenAI for abstract).'),
    size: sizeEnum.optional(),
    style: styleEnum.optional(),
    augment_prompt_for_transparency: z
      .boolean()
      .optional()
      .describe('Add the solid-green-background hint so the background can be keyed out (default true).'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const source = input.source ?? pickSource({ style: input.style });
    const augment = input.augment_prompt_for_transparency ?? true;
    const prompt = augment ? augmentPromptForTransparency(input.prompt) : input.prompt;
    const started = Date.now();
    const g = await runGeneration(
      ctx.api,
      { prompt, source, size: input.size, workspace: input.workspace },
      { progress: ctx.progress, signal: ctx.signal },
    );
    return {
      image_uuid: g.image_uuid,
      image_url: g.image_url,
      source_used: g.source_used,
      generation_latency_ms: Date.now() - started,
    };
  },
});

export const processTransparency = defineTool({
  name: 'process_transparency',
  description:
    'Key a solid background out of a generated image to true RGBA transparency (flood-fill + enclosed-region sweep + tight crop) and upload the result. Runs locally (needs Python + Pillow). Returns a NEW image_uuid.',
  inputSchema: z.object({
    image_uuid: z.string().min(1),
    image_url: z.string().url().optional().describe('The image URL, if known (else resolved from the uuid).'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) =>
    processTransparencyImpl(ctx, input.image_uuid, input.image_url, input.workspace),
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
    'End-to-end apparel design with the platform lessons baked in: solid-green-background prompt, transparency keying, and (optionally) a local text check. Returns ready-to-use design(s). Streams progress. Set needs_transparency=false for all-over-print products.',
  inputSchema: z.object({
    prompt: z.string().min(1),
    count: z.number().int().positive().max(4).optional(),
    garment_type: z.string().optional().describe('Hints source selection.'),
    style: styleEnum.optional(),
    needs_transparency: z.boolean().optional(),
    verify_text: z.boolean().optional(),
    source: z.string().optional(),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const count = input.count ?? 1;
    const needsTransparency = input.needs_transparency ?? true;
    const verifyText = input.verify_text ?? true;
    const source = input.source ?? pickSource({ style: input.style });
    const designs: Record<string, unknown>[] = [];

    for (let i = 0; i < count; i += 1) {
      await ctx.progress.report(Math.round((i / count) * 100), `Design ${i + 1} of ${count}...`);
      const prompt = augmentPromptForTransparency(input.prompt);
      const gen = await runGeneration(
        ctx.api,
        { prompt, source, workspace: input.workspace },
        { progress: ctx.progress, signal: ctx.signal },
      );

      const design: Record<string, unknown> = {
        design_uuid: gen.image_uuid,
        design_url: gen.image_url,
        source_used: gen.source_used,
        transparency_clean: false,
      };

      if (needsTransparency) {
        try {
          const t = await processTransparencyImpl(ctx, gen.image_uuid, gen.image_url, input.workspace);
          design.design_uuid = t.image_uuid;
          design.design_url = t.image_url;
          design.transparency_clean = t.corners_clean;
        } catch (err) {
          // Degrade (don't fail the whole tool) when the local toolchain is missing — return the
          // raw solid-green design with a clear warning so the agent can finish transparency
          // another way.
          if (err instanceof AhError && err.code === 'local_tool_unavailable') {
            design.transparency_clean = false;
            design.warning = `${err.message} ${err.suggestion ?? ''}`.trim();
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
    'Generate a variation of an existing design via img2img (e.g. "make the cactus blue"). Only Nano Banana and OpenAI support editing; other sources are rejected by the API.',
  inputSchema: z.object({
    source_design_uuid: z.string().min(1),
    change_description: z.string().min(1),
    preserve: z.array(z.enum(['composition', 'subject', 'style'])).optional(),
    source: z.string().optional().describe('Editing source (default Nano Banana).'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const source = input.source ?? 'Nano Banana';
    if (!EDIT_CAPABLE_SOURCES.has(source)) {
      throw new AhError({
        code: 'unprocessable',
        message: `Source "${source}" does not support editing. Use Nano Banana or OpenAI.`,
      });
    }
    const preserve = input.preserve ?? ['composition', 'subject'];
    const prompt = buildIterationPrompt(input.change_description, preserve);
    const g = await runGeneration(
      ctx.api,
      { prompt, source, sourceImageUuid: input.source_design_uuid, workspace: input.workspace },
      { progress: ctx.progress, signal: ctx.signal },
    );
    return { design_uuid: g.image_uuid, design_url: g.image_url, source_used: g.source_used };
  },
});

export const designTools: ToolDef[] = [
  generateImage,
  processTransparency,
  verifyDesignText,
  designApparel,
  iterateDesign,
];
