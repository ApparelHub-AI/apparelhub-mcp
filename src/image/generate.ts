import type { ApiClient } from '../http/client.js';
import { AhError } from '../errors.js';
import {
  isFallbackableError,
  isContentBlockError,
  contentBlockSweep,
  providerOf,
  CONTENT_BLOCKED_ALL_MODELS,
} from '../knowledge/sources.js';
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

  // A SYNCHRONOUS success (a model that isn't on the platform's async slow-list, e.g. Grok Imagine
  // — the only fast/sync source now — or a slow model that slipped to the sync path) returns 200 with the image nested
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
 *
 * A CONTENT BLOCK takes a second, wider path. Content guards are provider-specific — a prompt one
 * vendor refuses on recitation grounds routinely renders elsewhere — so on the first
 * `content_blocked` the short ladder is EXTENDED IN PLACE with a provider-diverse sweep of every
 * remaining model (contentBlockSweep). This is affordable precisely because a refusal is fast:
 * ~4.2s measured, quicker than a ~6.0s success, since the model never generates anything.
 */
export async function runGenerationWithFallback(
  api: ApiClient,
  opts: GenerateWithFallbackOptions,
  deps: GenerateDeps = {},
): Promise<GeneratedImageWithFallback> {
  // A QUEUE, not a fixed list: a content block appends the full sweep to it mid-flight.
  const queue = opts.sources.length ? [...opts.sources] : [opts.source];
  const trail: FallbackAttempt[] = [];
  let lastError: unknown;
  let sweepExtended = false;

  for (let i = 0; i < queue.length; i += 1) {
    const source = queue[i]!;
    try {
      const g = await runGeneration(api, { ...opts, source }, deps);
      // g.source_used is the model that actually produced the image (== source here).
      return { ...g, fallback_trail: trail };
    } catch (err) {
      lastError = err;
      // noFallback: honor the caller's "this model only" — surface the error as-is. Checked first
      // so the opt-out suppresses the content-block sweep too, not just the ladder.
      if (opts.noFallback) throw err;

      const code = err instanceof AhError ? err.code : undefined;
      const reason = err instanceof AhError ? `${err.code}: ${err.message}` : String(err);

      if (isContentBlockError(err)) {
        // Extend once, on the FIRST block: every model not already queued, ordered so the next
        // rungs land on different guards. Excluding the whole queue (not just what has been tried)
        // keeps a model from being scheduled twice.
        if (!sweepExtended) {
          sweepExtended = true;
          // An edit can only fall back to an edit-capable model; a text-to-image-only model would
          // spend a rung on a guaranteed rejection.
          queue.push(...contentBlockSweep({ edit: Boolean(opts.sourceImageUuid), exclude: queue }));
        }
        trail.push({ source, reason, ...(code ? { code } : {}) });
        const remaining = queue.length - i - 1;
        await deps.progress?.report(
          15,
          `${source} refused this on content grounds; trying a different provider` +
            `${remaining > 0 ? ` (${remaining} model${remaining === 1 ? '' : 's'} left)` : ''}...`,
        );
        continue;
      }

      // A non-transient failure (validation/auth/forbidden/not_found) must surface immediately;
      // cycling models would not help and would hide the real cause. A platform_rate_limited
      // (ApparelHub's own per-key throttle) is deliberately NOT fallbackable either — every model
      // rides the same key, so it also surfaces here.
      if (!isFallbackableError(err)) throw err;
      trail.push({ source, reason, ...(code ? { code } : {}) });
      // Fall through to the next model (if any).
      await deps.progress?.report(15, `${source} unavailable (${reason}); trying next model...`);
    }
  }

  // Every model in the ladder was tried and every one was rate-limited/transiently down.
  const summary = trail.map((t) => `${t.source} (${t.reason})`).join('; ');
  const base = lastError instanceof AhError ? lastError : undefined;

  // EVERY model refused on content grounds. This is the one terminal state that makes abandoning
  // the design legitimate, so it gets its own code and says so explicitly — a generic failure here
  // reads as "something went wrong, retry", which is exactly the wrong next move.
  if (trail.length > 0 && trail.every((t) => t.code === 'content_blocked')) {
    const tried = trail.map((t) => {
      const p = providerOf(t.source);
      return p ? `${t.source} [${p}]` : t.source;
    });
    const providers = [...new Set(trail.map((t) => providerOf(t.source)).filter(Boolean))];
    throw new AhError({
      code: CONTENT_BLOCKED_ALL_MODELS,
      httpStatus: base?.httpStatus,
      message:
        `Every available image model refused this prompt on content grounds ` +
        `(${tried.length} model${tried.length === 1 ? '' : 's'} across ` +
        `${providers.length} provider${providers.length === 1 ? '' : 's'}: ${tried.join(', ')}).`,
      suggestion:
        'The full model sweep is exhausted — this is the one case where abandoning the design is ' +
        'the right call, and no amount of rewording the same idea will change it. If the design ' +
        'still matters, change the SUBJECT: vary the motif and palette away from the recognisable ' +
        'signature the guards are reacting to, rather than rephrasing the same request.',
    });
  }
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
    // Machine-readable failure code (apparelhub-ai#825). Absent on older platform builds and on
    // failures recorded before it shipped, so every use below stays optional.
    const errorCode = str(s, 'error_code') ?? str(gi, 'error_code') ?? str(data, 'error_code');

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
      // The platform distinguishes three failure kinds that used to be one opaque string
      // (apparelhub-ai#825), and they have three DIFFERENT remedies.
      //
      // `content_blocked` is the one caused by the prompt, but that does NOT make it terminal:
      // content guards are provider-specific, so switching model is in fact the single most
      // effective response. runGenerationWithFallback catches this code and sweeps every remaining
      // model, provider-diverse. (The suggestion below used to say "do not switch model, because
      // every model refuses the same request" — that was wrong, and it is what left agents
      // rewording a prompt six times while nine other models sat untried.)
      if (errorCode === 'content_blocked') {
        throw new AhError({
          code: 'content_blocked',
          message: error ?? 'The image provider blocked this prompt on content-policy grounds.',
          suggestion:
            'One model refused this — that alone is NOT grounds to abandon the design. A different ' +
            'provider often renders the same prompt, because these guards are provider-specific, ' +
            'and the server sweeps the remaining models automatically. Only a ' +
            'content_blocked_all_models result means every model refused. Common causes: a named ' +
            'copyrighted character, a real brand mark, or a real person.',
        });
      }
      if (errorCode === 'no_image_returned' || errorCode === 'text_response_instead_of_image') {
        const rephrase = errorCode === 'text_response_instead_of_image';
        throw new AhError({
          code: errorCode,
          message:
            error ??
            (rephrase
              ? 'The model answered with text instead of an image.'
              : 'The model finished without returning an image.'),
          suggestion: rephrase
            ? 'Rephrase the prompt as a description of a flat 2D graphic, or try a different ' +
              'source — the fallback ladder does this automatically. Asking for 3D, video or ' +
              'vector output commonly triggers this.'
            : 'Retry, or try a different source — the fallback ladder does this automatically. ' +
              'This is not a problem with the prompt.',
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
        suggestion: 'Retry, or use the fast synchronous model (Grok Imagine).',
      });
    }
    poll += 1;
    await deps.progress?.report(Math.min(90, 20 + poll * 8), `Rendering (poll ${poll})...`);
    await sleep(intervalMs);
  }
}
