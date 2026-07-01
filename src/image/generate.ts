import type { ApiClient } from '../http/client.js';
import { AhError } from '../errors.js';
import { isRecord, str } from '../util/shape.js';
import type { ProgressReporter } from '../progress.js';

// Image-generation orchestration, including the async contract (api-contract §Image generation):
// POST /images/generate returns either the image inline (fast models) OR HTTP 202 with an
// image_uuid to poll at /images/upload/{uuid}/status (slow models — Nano Banana etc.). The
// ApiClient already retries transient 5xx/429, so the poll loop here stays simple.

export interface GenerateOptions {
  prompt: string;
  source: string;
  size?: string;
  sourceImageUuid?: string;
  workspace?: string;
}

export interface GeneratedImage {
  image_uuid: string;
  image_url: string;
  source_used: string;
}

export interface GenerateDeps {
  progress?: ProgressReporter;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runGeneration(
  api: ApiClient,
  opts: GenerateOptions,
  deps: GenerateDeps = {},
): Promise<GeneratedImage> {
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    source: opts.source,
    size: opts.size ?? '1024x1024',
  };
  if (opts.sourceImageUuid) body.source_image_uuid = opts.sourceImageUuid;

  await deps.progress?.report(10, `Generating with ${opts.source}...`);
  const res = await api.post('images/generate', {
    body,
    workspace: opts.workspace,
    signal: deps.signal,
  });

  const uuid = str(res, 'image_uuid', 'uuid') ?? '';
  const directUrl = str(res, 'url', 'image_url', 'full_url');
  const status = str(res, 'processing_status', 'status');

  // Fast path: the image came back inline.
  if (directUrl && status !== 'pending' && status !== 'processing') {
    await deps.progress?.report(100, 'Design ready.');
    return { image_uuid: uuid, image_url: directUrl, source_used: opts.source };
  }

  // Async path: poll to completion.
  if (!uuid) {
    throw new AhError({
      code: 'generation_failed',
      message: 'Generation returned neither an image URL nor a pollable image_uuid.',
    });
  }
  const url = await pollGeneration(api, uuid, deps, opts.workspace);
  return { image_uuid: uuid, image_url: url, source_used: opts.source };
}

async function pollGeneration(
  api: ApiClient,
  uuid: string,
  deps: GenerateDeps,
  workspace?: string,
): Promise<string> {
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? 600_000;
  const intervalMs = deps.intervalMs ?? 5_000;
  const start = Date.now();
  let poll = 0;

  for (;;) {
    const s = await api.get(`images/upload/${encodeURIComponent(uuid)}/status`, {
      workspace,
      signal: deps.signal,
    });
    const gi = isRecord(s) && isRecord(s.generated_image) ? s.generated_image : undefined;
    const data = isRecord(s) && isRecord(s.data) ? s.data : undefined;
    const status =
      str(s, 'processing_status', 'status') ??
      str(gi, 'processing_status') ??
      str(data, 'processing_status') ??
      'unknown';
    const url = str(s, 'url') ?? str(gi, 'url') ?? str(data, 'url');
    const error = str(s, 'error') ?? str(gi, 'error') ?? str(data, 'error');

    if (status === 'failed') {
      throw new AhError({
        code: 'generation_failed',
        message: error ? `Generation failed: ${error}` : 'Generation failed.',
      });
    }
    if (status === 'completed' && url) {
      await deps.progress?.report(100, 'Design ready.');
      return url;
    }
    if (Date.now() - start >= timeoutMs) {
      throw new AhError({
        code: 'generation_timeout',
        message: `Generation did not complete within ${Math.round(timeoutMs / 1000)}s.`,
        suggestion: 'Retry, or use a faster model (OpenAI, Grok Imagine, Flux 1.1 Pro).',
      });
    }
    poll += 1;
    await deps.progress?.report(Math.min(90, 20 + poll * 8), `Rendering (poll ${poll})...`);
    await sleep(intervalMs);
  }
}
