import type { ApiClient } from '../http/client.js';
import { AhError } from '../errors.js';
import { isFallbackableError } from '../knowledge/sources.js';
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

/** One rung of a fallback attempt: the model that was tried and why it was abandoned. */
export interface FallbackAttempt {
  source: string;
  reason: string;
  /** The structured error code of the failure (e.g. model_rate_limited), for honest attribution. */
  code?: string;
}

export interface GenerateWithFallbackOptions extends GenerateOptions {
  /** The ordered ladder of sources to try (from fallbackLadder). The first is the primary. */
  sources: string[];
  /** Disable falling back: try only the first source and rethrow its error. */
  noFallback?: boolean;
}

export interface GeneratedImageWithFallback extends GeneratedImage {
  /** The models that were tried-and-abandoned before the one that succeeded (empty on first try). */
  fallback_trail: FallbackAttempt[];
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

  // A SYNCHRONOUS success (a model that isn't on the platform's async slow-list, e.g. OpenAI /
  // Grok Imagine, or a slow model that slipped to the sync path) returns 200 with the image nested
  // under `generated_image`, NOT top-level like the async 202 does. Read both shapes so a synchronous
  // success isn't misreported as generation_failed even though it saved (ApparelHub-AI/apparelhub-mcp#70).
  const gi = isRecord(res) && isRecord(res.generated_image) ? res.generated_image : undefined;
  const uuid =
    str(res, 'image_uuid', 'uuid') ?? str(gi, 'uuid', 'image_uuid') ?? '';
  const directUrl =
    str(res, 'url', 'image_url', 'full_url') ?? str(gi, 'url', 'image_url', 'full_url');
  const status =
    str(res, 'processing_status', 'status') ?? str(gi, 'processing_status', 'status');

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

/**
 * Run a generation with a model-fallback ladder (epic #67). Tries each source in `opts.sources`;
 * on a rate-limit/transient failure (isFallbackableError) it records the attempt and moves to the
 * next model; a NON-fallbackable error (validation / auth / forbidden / not_found) rethrows
 * immediately. The per-model transient retries are already exhausted inside the ApiClient before
 * runGeneration throws, so reaching the fallback here means the model itself is throttled/down.
 *
 * The ladder is short (≤3 sync fallbacks), so the wall-clock cost of exhausting it is bounded even
 * though the first source may be an async-polled model.
 */
export async function runGenerationWithFallback(
  api: ApiClient,
  opts: GenerateWithFallbackOptions,
  deps: GenerateDeps = {},
): Promise<GeneratedImageWithFallback> {
  const sources = opts.sources.length ? opts.sources : [opts.source];
  const trail: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i]!;
    try {
      const g = await runGeneration(api, { ...opts, source }, deps);
      // g.source_used is the model that actually produced the image (== source here).
      return { ...g, fallback_trail: trail };
    } catch (err) {
      lastError = err;
      // noFallback: honor the caller's "this model only" — surface the error as-is.
      if (opts.noFallback) throw err;
      // A non-transient failure (validation/auth/forbidden/not_found) must surface immediately;
      // cycling models would not help and would hide the real cause. A platform_rate_limited
      // (ApparelHub's own per-key throttle) is deliberately NOT fallbackable either — every model
      // rides the same key, so it also surfaces here.
      if (!isFallbackableError(err)) throw err;
      const code = err instanceof AhError ? err.code : undefined;
      const reason = err instanceof AhError ? `${err.code}: ${err.message}` : String(err);
      trail.push({ source, reason, ...(code ? { code } : {}) });
      // Fall through to the next model (if any).
      await deps.progress?.report(15, `${source} unavailable (${reason}); trying next model...`);
    }
  }

  // Every model in the ladder was tried and every one was rate-limited/transiently down.
  const summary = trail.map((t) => `${t.source} (${t.reason})`).join('; ');
  const base = lastError instanceof AhError ? lastError : undefined;
  // Honest attribution when the WHOLE ladder was provider-throttled: the final error keeps the
  // precise model_rate_limited code so an agent reports "the model providers are rate limiting",
  // never "ApparelHub is rate limiting" (ApparelHub accepted every request).
  if (trail.length > 0 && trail.every((t) => t.code === 'model_rate_limited')) {
    throw new AhError({
      code: 'model_rate_limited',
      httpStatus: base?.httpStatus,
      retryAfter: base?.retryAfter,
      message: `Image generation failed: every fallback model's provider is currently rate limiting (${summary}).`,
      suggestion:
        'Every model on the ladder was throttled by its own provider — this is NOT ApparelHub\'s request throttle. Back off and retry later; switching models has already been tried.',
    });
  }
  throw new AhError({
    code: base?.code ?? 'generation_failed',
    httpStatus: base?.httpStatus,
    retryAfter: base?.retryAfter,
    message: `Image generation failed after trying every fallback model: ${summary}.`,
    suggestion:
      'Every model on the fallback ladder was rate-limited or transiently unavailable. Back off and retry later.',
  });
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
      // Async models report a provider rate limit as a structured error string (platform
      // contract, apparelhub-ai#506): "model_rate_limited: {source} throttled by provider
      // (retry_after={n}s)". Parse it into the precise model_rate_limited code so the fallback
      // ladder triggers on the code (not a message heuristic) and attribution stays honest.
      if (error && /^model_rate_limited:/.test(error)) {
        const m = /^model_rate_limited:\s*(.+?) throttled by provider \(retry_after=(\d+)s\)/.exec(
          error,
        );
        const source = m?.[1];
        throw new AhError({
          code: 'model_rate_limited',
          httpStatus: 429,
          source,
          retryAfter: m ? Number(m[2]) : undefined,
          message: source
            ? `The "${source}" model's provider rate-limited this generation.`
            : `A model provider rate limit failed this generation: ${error}`,
          suggestion:
            'Retry with a DIFFERENT source — the built-in fallback ladder does this automatically. This is the model provider throttling, not ApparelHub\'s request throttle.',
        });
      }
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
