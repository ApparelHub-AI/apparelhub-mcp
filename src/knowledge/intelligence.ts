/**
 * Garment print-geometry resolution (Garment Intelligence epic, apparelhub-ai#549 / mcp#100).
 *
 * The face layouts, print-style routing, and interior-surface blanking that drive product
 * composition live in TWO places now:
 *
 *  - the bundled tables in `garments.ts` (this package, world-readable) — the DEFAULT, used by
 *    local `npx` and as the always-available fallback; and
 *  - a private `garment_layouts` store on the platform, resolved at prepare time over a
 *    SERVICE-key endpoint. The HOSTED server (which alone holds `MCP_SERVICE_KEY`) prefers the
 *    platform so new calibrations reach it the moment they land as DB rows — no npm release, no
 *    version skew. See epic #549 (D1: raw rects flow ONLY over the service-key / SuperAdmin
 *    surfaces).
 *
 * A `GarmentLayoutResolver` exposes exactly the four bundled functions the compositor consumes,
 * so `product.ts` calls the resolver instead of the raw tables. The platform response already
 * merges DB rows + the platform's family rules (ported 1:1 from `garments.ts`), so it is a
 * COMPLETE replacement when available — there is no double fallback. `extremeAspectWarning`
 * stays a direct bundled call in `product.ts`: it is a generic "unknown extreme aspect, verify
 * the mockup" heuristic, not calibration IP, and it only fires when no face was resolved.
 */
import {
  faceLayoutFor,
  isInteriorPlacement,
  placedStyleFor,
  printStyleFor,
  type FaceLayout,
  type FaceRect,
  type PrintStyle,
} from './garments.js';

export interface GarmentLayoutResolver {
  /** The face layout for one placement, or undefined when the compositor should treat it as a
   *  plain area (placed art / solid structural panel). */
  faceLayout(providerRefId: string, areaWidth: number, areaHeight: number): FaceLayout | undefined;
  printStyle(): PrintStyle;
  placedStyle(): 'chest_fill' | 'back_center';
  /** True for interior/non-display surfaces that must print BLANK (inside covers, journal
   *  pages, care labels) — plus any per-row exclude_placements the platform added. */
  isInterior(providerRefId: string): boolean;
  /** Where the layout came from — 'platform' when resolved from a garment_layouts-backed
   *  response, 'bundled' for the local tables / fallback. Diagnostics only. */
  readonly source: 'platform' | 'bundled';
}

export interface GeometryPlacement {
  provider_ref_id: string;
  area_width: number;
  area_height: number;
}

/** The local tables — exact pre-#549 behavior. The default everywhere the platform is absent. */
export function bundledLayoutResolver(garmentName: string | undefined): GarmentLayoutResolver {
  return {
    faceLayout: (ref, w, h) => faceLayoutFor(garmentName, ref, w, h),
    printStyle: () => printStyleFor(garmentName),
    placedStyle: () => placedStyleFor(garmentName),
    isInterior: (ref) => isInteriorPlacement(ref),
    source: 'bundled',
  };
}

interface PlatformPlacementEntry {
  faces: FaceRect[];
  note?: string;
}

interface PlatformResolveResponse {
  print_style?: PrintStyle;
  placed_style?: 'chest_fill' | 'back_center';
  placements?: Record<string, PlatformPlacementEntry | null>;
  interior_placements?: string[];
}

function isPlatformResponse(v: unknown): v is PlatformResolveResponse {
  return typeof v === 'object' && v !== null;
}

function platformLayoutResolver(
  garmentName: string | undefined,
  resp: PlatformResolveResponse,
): GarmentLayoutResolver {
  const placements = resp.placements ?? {};
  const interior = new Set(resp.interior_placements ?? []);
  return {
    faceLayout: (ref) => {
      const e = placements[ref];
      if (!e || !Array.isArray(e.faces) || e.faces.length === 0) return undefined;
      return { faces: e.faces, note: e.note ?? '' };
    },
    // The platform's print_style / placed_style already apply the same apparel-first routing;
    // fall back to the bundled derivation only if the field is somehow absent.
    printStyle: () => resp.print_style ?? printStyleFor(garmentName),
    placedStyle: () => resp.placed_style ?? placedStyleFor(garmentName),
    // interior_placements carries both the generic rule's hits (for placements sent) and the
    // DB row's exclude_placements; the generic regex backstops anything not in the request.
    isInterior: (ref) => interior.has(ref) || isInteriorPlacement(ref),
    source: 'platform',
  };
}

export interface ResolveOptions {
  /** MCP_SERVICE_KEY — set ONLY in the hosted Lambda's environment. Absent => bundled. */
  serviceKey?: string;
  /** The hosted platform base (config.baseUrl == APPARELHUB_API_BASE_URL in hosted mode). */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

// Process-lifetime cache (mcp#100): one resolved layout per (provider, product_ref). The garment
// endpoint is deterministic per catalog ref, so the resolution never varies within a container.
// Only PLATFORM resolutions are cached — a transient endpoint failure falls back to bundled for
// that one call and retries the platform next time (never pins the fallback for the container).
const layoutCache = new Map<string, GarmentLayoutResolver>();

export function _clearIntelligenceCacheForTests(): void {
  layoutCache.clear();
}

async function fetchPlatformLayout(
  providerUuid: string,
  productRef: string,
  garmentName: string | undefined,
  placements: GeometryPlacement[],
  opts: ResolveOptions,
): Promise<GarmentLayoutResolver> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(`${opts.baseUrl}/service/garment-intelligence/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': opts.serviceKey as string },
    body: JSON.stringify({
      provider_uuid: providerUuid,
      product_ref: productRef,
      garment_name: garmentName,
      placements,
    }),
    signal: opts.signal,
  });
  if (response.status !== 200) throw new Error(`garment-intelligence resolve ${response.status}`);
  const body: unknown = await response.json();
  if (!isPlatformResponse(body)) throw new Error('garment-intelligence resolve: malformed body');
  return platformLayoutResolver(garmentName, body);
}

/**
 * Resolve the layout for a garment. Prefers the platform when a service key is configured
 * (hosted only); on any failure — or with no service key (local `npx`) — returns the bundled
 * tables so composition never breaks.
 */
export async function resolveGarmentLayout(
  providerUuid: string,
  productRef: string,
  garmentName: string | undefined,
  placements: GeometryPlacement[],
  opts: ResolveOptions,
): Promise<GarmentLayoutResolver> {
  if (!opts.serviceKey) return bundledLayoutResolver(garmentName);

  const key = `${providerUuid}::${productRef}`;
  const cached = layoutCache.get(key);
  if (cached) return cached;

  let resolver: GarmentLayoutResolver;
  try {
    resolver = await fetchPlatformLayout(providerUuid, productRef, garmentName, placements, opts);
  } catch {
    // Endpoint unavailable / non-200 / malformed — degrade to bundled for THIS call only.
    return bundledLayoutResolver(garmentName);
  }
  layoutCache.set(key, resolver);
  return resolver;
}
