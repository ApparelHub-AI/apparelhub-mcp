// AI image-source selection + the async-generation contract, distilled from the skill's
// design rules.

import { AhError } from '../errors.js';

export const VALID_SOURCES = [
  'Nano Banana',
  'Seedream 4.0',
  'Seedream 4.5',
  'OpenAI',
  'Flux 1.1 Pro',
  'Flux 2 Pro',
  'Google Imagen 4',
  'GPT Image 2',
  'Grok Imagine',
  'Wan 2.7',
] as const;

export type DesignStyle = 'photoreal' | 'vector' | 'abstract' | 'auto';

// Slow models run through the async pipeline: POST returns 202 + image_uuid, and the caller
// polls /images/upload/{uuid}/status. Fast models return the image inline. (Nano Banana — the
// platform default — is async.)
export const ASYNC_SOURCES = new Set<string>([
  'Nano Banana',
  'Seedream 4.0',
  'Seedream 4.5',
  'Flux 2 Pro',
  'Google Imagen 4',
  'Wan 2.7',
  'GPT Image 2',
]);

export function isAsyncSource(source: string): boolean {
  return ASYNC_SOURCES.has(source);
}

// Only Nano Banana and OpenAI support the img2img edit endpoint; Replicate-backed sources 422.
export const EDIT_CAPABLE_SOURCES = new Set<string>(['Nano Banana', 'OpenAI']);

/** Pick a source. Nano Banana is the best all-rounder (photoreal + text); OpenAI is the pick
 *  for purely abstract art. The user can always override with an explicit source. */
export function pickSource(opts: { style?: DesignStyle; hasText?: boolean } = {}): string {
  if (opts.style === 'abstract') return 'OpenAI';
  return 'Nano Banana';
}

// The default fallback ladder (spec §Phase 1). Nano Banana first (best all-rounder), then
// Flux 1.1 Pro (Replicate) and OpenAI (OpenAI). Each rung is on a DIFFERENT provider, so a
// per-provider rate limit on the first is escaped; the fallbacks are also fast (OpenAI is
// synchronous, Flux 1.1 Pro is quick), so the time cost of falling back is small. Abstract art
// prefers OpenAI. Edit (img2img) can only run on the two edit-capable sources.
const DEFAULT_LADDER = ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'];
const ABSTRACT_LADDER = ['OpenAI', 'Nano Banana'];
const EDIT_LADDER = ['Nano Banana', 'OpenAI'];

/** Build the ordered, de-duplicated list of sources to try for one generation. When an explicit
 *  `source` is given it goes FIRST, then the appropriate ladder is appended (deduped). When
 *  `edit` is true the list is restricted to the edit-capable sources (img2img); Replicate-backed
 *  sources 422 on the edit endpoint, so they can never be a valid edit fallback. */
export function fallbackLadder(
  opts: { style?: DesignStyle; source?: string; edit?: boolean } = {},
): string[] {
  const base = opts.edit ? EDIT_LADDER : opts.style === 'abstract' ? ABSTRACT_LADDER : DEFAULT_LADDER;
  const ordered = opts.source ? [opts.source, ...base] : [...base];
  const seen = new Set<string>();
  const ladder: string[] = [];
  for (const s of ordered) {
    if (opts.edit && !EDIT_CAPABLE_SOURCES.has(s)) continue; // an explicit non-edit source is dropped for edits
    if (seen.has(s)) continue;
    seen.add(s);
    ladder.push(s);
  }
  return ladder;
}

// Error codes that mean "this MODEL/provider was throttled or transiently failed" — safe to retry
// with a DIFFERENT model. Kept in ONE place so Phase 3 (which adds the `model_rate_limited` code)
// can extend it. NOTE: the ApiClient already retries transient 429/502/503/504 up to ~5x per model
// before it throws, so by the time one of these codes reaches the fallback layer the per-model
// transient retries are exhausted → that is exactly the moment to fall back to the next model.
const FALLBACKABLE_CODES = new Set<string>([
  'rate_limited', // 429 from the platform (mapHttpError)
  'model_rate_limited', // Phase 3: the platform will signal a per-MODEL rate limit distinctly
  'upstream_unavailable', // 5xx from the platform (mapHttpError)
  'network_error', // transient connectivity failure after the client exhausted its own retries
  'generation_timeout', // async poll never completed — try a (faster) different model
]);
// Rate-limit-shaped text, used to decide whether an ambiguous `generation_failed` is fallbackable.
const RATE_LIMIT_MESSAGE_RE = /rate.?limit|quota|429|resource.?exhausted|too many/i;

/** TRUE for rate-limit / transient failures that warrant trying a different model. Validation
 *  (bad_request/unprocessable), auth (auth_required), forbidden/membership-quota (forbidden), and
 *  not_found MUST return FALSE so they surface immediately. A `generation_failed` is fallbackable
 *  ONLY when it is rate-limit-shaped (code === 'model_rate_limited' or a rate-limit message). */
export function isFallbackableError(err: unknown): boolean {
  if (!(err instanceof AhError)) return false;
  if (FALLBACKABLE_CODES.has(err.code)) return true;
  if (err.code === 'generation_failed') return RATE_LIMIT_MESSAGE_RE.test(err.message);
  return false;
}

const GREEN_BG_HINT =
  'Render the design on a solid, flat, fully-saturated pure chroma-key green background ' +
  '(exactly RGB 0,255,0 / #00FF00) that fills the entire canvas edge to edge behind the subject. ' +
  'The green must be one uniform color with NO gradient, NO shading, NO vignette, and NO yellow, ' +
  'lime, olive, or sage tint. Do NOT make the background transparent and do NOT draw a ' +
  'checkerboard pattern.';

/** Lesson 9b: never ask a model for a "transparent background" — request a solid green one and
 *  key it out afterward. Idempotent (skips if the prompt already asks for a green background). */
export function augmentPromptForTransparency(prompt: string): string {
  if (/#?00ff00|(solid|bright) green background/i.test(prompt)) return prompt.trim();
  return `${prompt.trim()} ${GREEN_BG_HINT}`;
}

/** Build an img2img edit prompt from a change description + a list of aspects to preserve. */
export function buildIterationPrompt(change: string, preserve: string[]): string {
  const keep = preserve.length ? ` Keep the ${preserve.join(', ')} the same.` : '';
  return `Edit the provided design: ${change.trim()}.${keep} Change only what is described and recompose cleanly.`;
}
