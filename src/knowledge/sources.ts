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

/** Find the closest VALID_SOURCES entry to a near-miss name (case-insensitive prefix overlap),
 *  used only to build a "did you mean …" hint — e.g. "Flux 1.1" -> "Flux 1.1 Pro". */
function nearestSource(source: string): string | undefined {
  const w = source.trim().toLowerCase();
  if (!w) return undefined;
  return VALID_SOURCES.find((s) => {
    const c = s.toLowerCase();
    return c.startsWith(w) || w.startsWith(c);
  });
}

/** Normalize a caller-supplied `source` to its canonical VALID_SOURCES spelling, case-insensitively.
 *  The platform's source-name match is case-insensitive too, but its slow-model async routing is
 *  case-SENSITIVE — so a near-miss like "SeeDream 4.5" would run synchronously and a wrong name like
 *  "Flux 1.1" would 500 there. Normalizing here forwards the exact canonical name, or throws a clear
 *  bad_request (non-fallbackable) listing the valid sources, instead of a confusing downstream
 *  failure (ApparelHub-AI/apparelhub-mcp#70). */
export function normalizeSource(source: string): string {
  const wanted = source.trim().toLowerCase();
  const match = VALID_SOURCES.find((s) => s.toLowerCase() === wanted);
  if (match) return match;
  const suggestion = nearestSource(source);
  throw new AhError({
    code: 'bad_request',
    message: `Unknown image source "${source}".`,
    suggestion: `${suggestion ? `Did you mean "${suggestion}"? ` : ''}Valid sources: ${VALID_SOURCES.join(', ')}.`,
  });
}

// Most sources support the img2img edit endpoint now (per-model Replicate editing). TWO do NOT:
// Google Imagen 4 (text-to-image only) and Flux 1.1 Pro (its img2img is Flux Redux — a
// composition/style VARIATION, not an instruction-editor, so it's not offered for editing). An
// edit on either returns a clean 400. Multi-reference (several source images) works on the
// array-input models — see the platform's per-source `supports_multi_image`.
export const EDIT_CAPABLE_SOURCES = new Set<string>([
  'Nano Banana', 'OpenAI', 'GPT Image 2',
  'Seedream 4.0', 'Seedream 4.5', 'Flux 2 Pro', 'Grok Imagine', 'Wan 2.7',
]);

/** Pick a source. Nano Banana is the best all-rounder (photoreal + text + abstract). OpenAI is
 *  deliberately NEVER preferred (operator directive: it's the least-preferred model — its account
 *  is a shared billing surface and it only wins on nothing today). The user can always override
 *  with an explicit source. */
export function pickSource(_opts: { style?: DesignStyle; hasText?: boolean } = {}): string {
  return 'Nano Banana';
}

// The default fallback ladder (spec §Phase 1). Nano Banana first (best all-rounder), then a
// Replicate model, and OpenAI ALWAYS LAST (operator directive: OpenAI is the least-preferred
// model — try everything else first). Each rung is on a DIFFERENT provider, so a per-provider
// rate limit / account limit on the first is escaped. Edit (img2img) runs on the edit-capable
// sources (almost everything now — only Google Imagen 4 is text-only). The auto EDIT_LADDER keeps
// the two most reliable, provider-diverse edit models (Nano Banana + OpenAI); an explicit edit on
// any other edit-capable source (Seedream, Flux, Grok, Wan, GPT Image 2) is honored via
// EDIT_CAPABLE_SOURCES.
const DEFAULT_LADDER = ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'];
const ABSTRACT_LADDER = ['Nano Banana', 'Flux 2 Pro', 'OpenAI'];
const EDIT_LADDER = ['Nano Banana', 'OpenAI'];

/** Build the ordered, de-duplicated list of sources to try for one generation. When an explicit
 *  `source` is given it goes FIRST, then the appropriate ladder is appended (deduped). When
 *  `edit` is true the list is restricted to the edit-capable sources (img2img); a text-to-image-only
 *  source (only Google Imagen 4) can never be a valid edit fallback. */
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
// with a DIFFERENT model. Kept in ONE place. NOTE: the ApiClient already retries transient
// 429/502/503/504 up to ~5x per model before it throws, so by the time one of these codes reaches
// the fallback layer the per-model transient retries are exhausted → that is exactly the moment to
// fall back to the next model.
//
// The 429 split (epic #66 phase 2) matters here: `model_rate_limited` (a specific model's upstream
// provider throttled) IS fallbackable — a different model rides a different provider. But
// `platform_rate_limited` (ApparelHub's own per-key request throttle) is deliberately ABSENT:
// that throttle is endpoint-wide on the key itself, so cycling models cannot help — it must
// surface immediately with its back-off guidance instead of burning more throttled requests.
const FALLBACKABLE_CODES = new Set<string>([
  'model_rate_limited', // a per-MODEL provider rate limit (sync 429 body or parsed async failure)
  'upstream_unavailable', // 5xx from the platform (mapHttpError)
  'request_not_sent', // transport failure — no response received; a different attempt may connect
  'network_error', // legacy alias of request_not_sent (belt-and-braces; no longer emitted)
  'generation_timeout', // async poll never completed — try a (faster) different model
  // The model finished without producing an image, for a reason unrelated to content policy
  // (platform code `no_image_returned`, apparelhub-ai#825). Model-specific and NOT caused by the
  // prompt, so a different model is exactly the right next move. Before the platform
  // distinguished this from a policy refusal it arrived as a bare `generation_failed` and killed
  // the whole ladder on the first rung.
  'no_image_returned',
  // The model answered conversationally instead of drawing. Also model-specific — another model
  // routinely renders the same prompt — so it is worth a rung rather than a hard stop.
  'text_response_instead_of_image',
]);
// DELIBERATELY ABSENT: `content_blocked` — but NOT because it is unrecoverable. It gets its own
// path (isContentBlockError + contentBlockSweep, below) because it wants the OPPOSITE treatment
// from everything above: the full model set rather than the short ladder.
//
// The reasoning here used to read "a content refusal is caused by the PROMPT, so every remaining
// model refuses the same request." That is wrong, and it is worth saying so plainly, because it is
// the assumption this path exists to correct. Content guards are PROVIDER-SPECIFIC: Google runs a
// recitation/copyright guard that the Replicate-hosted models do not have, so a prompt Google
// refuses on recitation grounds routinely renders on Flux or Seedream. Measured against
// production: one session hit a recitation block, reworded the same idea six times, was refused
// every time, and abandoned the design — while nine other models sat untried.
//
// It stays OUT of FALLBACKABLE_CODES so the two behaviours remain separately tunable. That set is
// for transient/per-model faults and is walked with a short ladder to bound wall-clock on slow
// retries. A content block is neither transient nor slow — measured ~4.2s to refuse, FASTER than
// the ~6.0s a success takes, because the model never generates anything — so the cap that protects
// the rate-limit path buys nothing here and would only truncate the sweep that does the work.
// Rate-limit-shaped text, used to decide whether an ambiguous `generation_failed` is fallbackable.
const RATE_LIMIT_MESSAGE_RE = /rate.?limit|quota|429|resource.?exhausted|too many/i;

/** TRUE for per-model / transient failures that warrant trying a different model. Validation
 *  (bad_request/unprocessable), auth (auth_required), forbidden/membership-quota (forbidden),
 *  not_found, AND `platform_rate_limited` (ApparelHub's own per-key throttle — model-independent)
 *  MUST return FALSE so they surface immediately. A `generation_failed` is fallbackable ONLY when
 *  its message is rate-limit-shaped (legacy heuristic; structured async failures now arrive as
 *  the precise `model_rate_limited` code instead). */
export function isFallbackableError(err: unknown): boolean {
  if (!(err instanceof AhError)) return false;
  if (FALLBACKABLE_CODES.has(err.code)) return true;
  // A prompt-length rejection is model-SPECIFIC: the identical prompt succeeds on a
  // model with a longer limit, which is exactly what fallback is for. Without this
  // the whole generation died on the first rung even though five other models
  // would have accepted it (#766). Checked before the message heuristic below
  // because these arrive as an http_error/generation_failed, not a rate limit.
  if (isPromptTooLongError(err)) return true;
  if (err.code === 'generation_failed') return RATE_LIMIT_MESSAGE_RE.test(err.message);
  return false;
}

/** The terminal code for "every model refused this on content grounds".
 *
 *  This is the ONLY signal that abandoning a design is legitimate. A single block never is —
 *  that was the behaviour being corrected. Kept distinct from `content_blocked` so an agent can
 *  tell "one model said no" from "all ten did". */
export const CONTENT_BLOCKED_ALL_MODELS = 'content_blocked_all_models';

/** TRUE when a provider refused on content/copyright grounds (platform code `content_blocked`,
 *  normalised across every provider by the platform side of this work). */
export function isContentBlockError(err: unknown): boolean {
  return err instanceof AhError && err.code === 'content_blocked';
}

// Which account/guard each model rides. This is the axis that matters after a content block:
// cycling to a sibling on the SAME host is the least useful move available, because it is the same
// guard that just refused.
//
// Note `Google Imagen 4` is a Google MODEL but is reached through Replicate, and `GPT Image 2` is
// native OpenAI (it shares the OpenAI account and therefore the OpenAI moderation surface).
const SOURCE_PROVIDER: Record<string, string> = {
  'Nano Banana': 'google',
  'OpenAI': 'openai',
  'GPT Image 2': 'openai',
  'Seedream 4.0': 'replicate',
  'Seedream 4.5': 'replicate',
  'Flux 1.1 Pro': 'replicate',
  'Flux 2 Pro': 'replicate',
  'Grok Imagine': 'replicate',
  'Wan 2.7': 'replicate',
  'Google Imagen 4': 'replicate',
};

// Preference order WITHIN each provider, best first. `Google Imagen 4` is deliberately last among
// the Replicate models: it is Google's model, so it is the Replicate entry most likely to carry a
// Google-flavoured guard and the least likely to help after Google has already refused.
const PROVIDER_MODEL_ORDER: Record<string, string[]> = {
  replicate: [
    'Flux 1.1 Pro', 'Seedream 4.5', 'Flux 2 Pro', 'Seedream 4.0',
    'Grok Imagine', 'Wan 2.7', 'Google Imagen 4',
  ],
  google: ['Nano Banana'],
  openai: ['OpenAI', 'GPT Image 2'],
};

// Providers round-robined first, then the last-resort group appended whole.
//
// OpenAI is pinned last by the standing operator directive that it is the least-preferred model
// (shared billing surface, wins on nothing today) — see pickSource. That directive and this
// path's own logic agree rather than conflict: OpenAI's guard is a moderation/safety guard, the
// same CLASS Replicate's per-model safety checkers use, so it adds no guard diversity that a
// Replicate model has not already supplied. Trying it earlier would cost an OpenAI generation for
// no extra chance of success.
const SWEEP_PROVIDER_ORDER = ['replicate', 'google'];
const SWEEP_LAST_RESORT_PROVIDERS = ['openai'];

/** Every model worth trying after a content block, ordered provider-diverse, minus `exclude`.
 *
 *  Round-robin across providers means the first few rungs each land on a DIFFERENT guard, which is
 *  where nearly all the value is: if a different guard is going to render this prompt, it renders
 *  on rung 2, not rung 7. Siblings on an already-refused host come later, once diversity is spent.
 *
 *  `edit` restricts to the edit-capable set — a text-to-image-only model can never be a valid edit
 *  fallback, and offering one would just spend a rung on a guaranteed 400. */
export function contentBlockSweep(
  opts: { edit?: boolean; exclude?: Iterable<string> } = {},
): string[] {
  const seen = new Set<string>(opts.exclude ?? []);
  const sweep: string[] = [];
  const push = (m: string | undefined): void => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    sweep.push(m);
  };
  /** The best still-untried model on this provider. `push` mutates `seen`, so calling this once
   *  per provider per round walks each provider's list in order. */
  const nextFrom = (provider: string): string | undefined =>
    (PROVIDER_MODEL_ORDER[provider] ?? []).find(
      (m) => !seen.has(m) && (!opts.edit || EDIT_CAPABLE_SOURCES.has(m)),
    );

  // Round-robin the preferred providers: one model each, then the next model each, and so on.
  const maxRounds = Math.max(
    ...SWEEP_PROVIDER_ORDER.map((p) => (PROVIDER_MODEL_ORDER[p] ?? []).length),
    0,
  );
  for (let round = 0; round < maxRounds; round += 1) {
    for (const provider of SWEEP_PROVIDER_ORDER) push(nextFrom(provider));
  }
  // Then the last-resort providers, in their own preference order.
  for (const provider of SWEEP_LAST_RESORT_PROVIDERS) {
    for (const m of PROVIDER_MODEL_ORDER[provider] ?? []) {
      if (!opts.edit || EDIT_CAPABLE_SOURCES.has(m)) push(m);
    }
  }
  return sweep;
}

/** The provider a source rides, for honest reporting. */
export function providerOf(source: string): string | undefined {
  return SOURCE_PROVIDER[source];
}

// Lesson 9b in as few characters as it can be said. The previous wording ran 331
// characters, so our own boilerplate was the majority of a typical design prompt
// and pushed it past Nano Banana's limit — five other models accepted the same
// request, which made it read as "Nano Banana is broken" (#766).
//
// Every clause that remains is load-bearing: flat and uniform (models otherwise
// shade or vignette it), the exact hex (a lime/sage green will not key cleanly),
// edge to edge (a partial background leaves a frame), and the two negatives
// (models asked for green still return checkerboards or real alpha). Trimmed to
// ~160 characters, not removed.
const GREEN_BG_HINT =
  'Background: one flat uniform #00FF00 (RGB 0,255,0) chroma-key green, edge to edge, ' +
  'no gradient or shading, no lime/sage tint. Not transparent, no checkerboard.';

/** Lesson 9b: never ask a model for a "transparent background" — request a solid green one and
 *  key it out afterward. Idempotent (skips if the prompt already asks for a green background).
 *
 *  ⚠️ Only call this when the design will actually be keyed. Appending it for an
 *  all-over print produced a green-framed image that nothing then keyed out (#765). */
export function augmentPromptForTransparency(prompt: string): string {
  if (/#?00ff00|(solid|bright) green background/i.test(prompt)) return prompt.trim();
  return `${prompt.trim()} ${GREEN_BG_HINT}`;
}

/** TRUE when a provider rejected the request for prompt LENGTH.
 *
 *  Distinct from a rate limit or a transient 5xx: retrying the same prompt on the
 *  same model can never succeed, but the same prompt on a model with a longer limit
 *  will. So it IS fallbackable — and it must never be reported to the agent as "the
 *  model is rate limiting" or "the model is down", because neither is true and both
 *  send the agent to the wrong remedy (#766). */
export function isPromptTooLongError(err: unknown): boolean {
  if (!(err instanceof AhError)) return false;
  return /request too long|prompt (is )?too long|too many tokens|maximum context/i.test(
    err.message ?? '',
  );
}

/** Build an img2img edit prompt from a change description + a list of aspects to preserve. */
export function buildIterationPrompt(change: string, preserve: string[]): string {
  const keep = preserve.length ? ` Keep the ${preserve.join(', ')} the same.` : '';
  return `Edit the provided design: ${change.trim()}.${keep} Change only what is described and recompose cleanly.`;
}
