// AI image-source selection + the async-generation contract, distilled from the skill's
// design rules.

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

const GREEN_BG_HINT =
  'Render the design on a solid bright green background (#00FF00) that fills the entire canvas ' +
  'behind the subject. Do NOT make the background transparent and do NOT draw a checkerboard ' +
  'pattern.';

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
