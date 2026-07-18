// Helpers for turning raw API payloads into clean, agent-friendly shapes, plus the
// `view_url` builders (tool spec §12 Q4 — every product/order/store result carries a link
// back into apparelhub.ai so the agent can end with "see it here" instead of dumping JSON).

const WEB_BASE = 'https://apparelhub.ai';

export const viewUrl = {
  product: (uuid: string): string => `${WEB_BASE}/merchandise/my-products/${uuid}`,
  store: (uuid: string): string => `${WEB_BASE}/stores/${uuid}`,
  order: (uuid: string): string => `${WEB_BASE}/orders/${uuid}`,
  designs: (): string => `${WEB_BASE}/images`,
};

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read the first present string value among candidate keys. */
export function str(obj: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(obj)) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** Read the first present number value among candidate keys. */
export function num(obj: unknown, ...keys: string[]): number | undefined {
  if (!isRecord(obj)) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

/** Read a provider VARIANT id, which is numeric on Printful/Printify but a STRING productUid on
 *  Gelato (e.g. "phonecase_apple_iphone-16_tough_white_glossy"). Returns a number for all-digit
 *  values, otherwise the raw string — NEVER coerces a non-numeric id to 0 (which silently drops
 *  Gelato variants and skips their mockup). The platform's preview/create/variant endpoints compare
 *  variant ids AS STRINGS, so passing the string through works for every provider. */
export function variantRef(obj: unknown, ...keys: string[]): number | string | undefined {
  if (!isRecord(obj)) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const t = v.trim();
      return /^\d+$/.test(t) ? Number(t) : t;
    }
  }
  return undefined;
}

/** Read the first present boolean among candidate keys. */
export function bool(obj: unknown, ...keys: string[]): boolean | undefined {
  if (!isRecord(obj)) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/** Coerce a value that might be an array, or `{items|data|results: [...]}`, or a bare object,
 *  into an array. Tolerant of the several envelope shapes the API uses across endpoints. */
export function asArray(raw: unknown, ...envelopeKeys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw)) {
    for (const k of [...envelopeKeys, 'items', 'data', 'results']) {
      if (Array.isArray(raw[k])) return raw[k] as unknown[];
    }
  }
  return [];
}

/** Total count for a paginated list: explicit `total`, else the page length. */
export function total(raw: unknown, pageLength: number): number {
  const t = num(raw, 'total', 'count', 'total_count');
  return t ?? pageLength;
}
