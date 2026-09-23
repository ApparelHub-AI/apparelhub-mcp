import type { ApiClient } from '../http/client.js';
import { AhError } from '../errors.js';
import { asArray, isRecord, str } from '../util/shape.js';
import type { ProgressReporter } from '../progress.js';

// Mockup generation. status="completed" now means the mockups are PUBLISHED, not merely
// rendered: publishing moved onto a background worker, and the platform only reports completed
// once each preview that landed carries a preview_url. So the two conditions this loop waits on
// normally arrive together.
//
// The preview_url check is kept anyway, deliberately. It costs nothing when both land at once,
// and returning a job whose previews have no usable URL is the failure it exists to prevent —
// worth guarding against a half-published job from an older run, or a provider path that has
// not been migrated. Removing it buys nothing and risks exactly the broken product cards that
// put it here.
//
// Historical (Lesson 53): publishing used to happen ON the poll, so preview_url could lag
// completed by 20+ minutes because nothing advanced until somebody polled again. That gap is
// gone, and a job now finishes even if the caller stops polling.
//
// Field names matter here (Lesson 2): the preview endpoint uses merchandise_provider_uuid +
// provider_product_ref_id + `templates`, which differ from the product-create endpoint.

export interface MockupParams {
  merchandise_provider_uuid: string;
  generated_image_uuid: string;
  provider_product_ref_id: string;
  templates: Record<string, unknown>[];
  variant_ids: (number | string)[];
}

export interface MockupResult {
  job_uuid: string;
  preview_url?: string;
  /**
   * Present when the design behind this mockup has an opaque background and
   * will therefore print as a coloured rectangle on a placed print
   * (apparelhub-ai#1151). Computed server side and returned by the poll.
   *
   * This defect has already shipped through an unattended run: a scheduled
   * build produced products whose printed artwork carried the green screen it
   * was generated on, because nothing checked. Carrying it here is what lets a
   * caller see it BEFORE the product is created.
   */
  design_check?: Record<string, unknown>;
}

export interface MockupDeps {
  progress?: ProgressReporter;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
  workspace?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function firstPreviewUrl(previews: unknown[]): string | undefined {
  for (const p of previews) {
    const url = str(p, 'preview_url');
    if (url) return url;
  }
  return undefined;
}

export async function runMockup(
  api: ApiClient,
  params: MockupParams,
  deps: MockupDeps = {},
): Promise<MockupResult> {
  const sleep = deps.sleep ?? defaultSleep;
  // A generous CAP, not an expectation: jobs normally finish in well under a minute now.
  // Left wide because exceeding it does not fail the run, it proceeds without the preview.
  const timeoutMs = deps.timeoutMs ?? 30 * 60 * 1000;
  const intervalMs = deps.intervalMs ?? 8000;

  await deps.progress?.report(10, 'Starting mockup...');
  const started = await api.post('merchandise/product/preview', {
    body: params,
    workspace: deps.workspace,
    signal: deps.signal,
  });
  const jobUuid = str(started, 'job_uuid', 'uuid', 'preview_job_uuid');
  if (!jobUuid) {
    throw new AhError({ code: 'mockup_failed', message: 'Mockup job did not return a job_uuid.' });
  }

  const start = Date.now();
  let poll = 0;
  for (;;) {
    const s = await api.get(
      `merchandise/product/preview/${encodeURIComponent(params.merchandise_provider_uuid)}/job/${encodeURIComponent(jobUuid)}`,
      { workspace: deps.workspace, signal: deps.signal },
    );
    const status = str(s, 'status', 'processing_status') ?? 'unknown';
    const previews = asArray(isRecord(s) ? (s.previews ?? s.previews_by_job) : undefined);
    const previewUrl = firstPreviewUrl(previews);
    // #1151 — absent when there is nothing to say, which is the common case.
    const designCheck =
      isRecord(s) && isRecord(s.design_check) ? (s.design_check as Record<string, unknown>) : undefined;

    if (status === 'failed') {
      throw new AhError({
        code: 'mockup_failed',
        message: 'Mockup generation failed.',
        suggestion: 'Retry, or verify the design + garment.',
      });
    }
    // Completed AND a usable URL. These normally arrive together now; the second
    // check is the safety net described at the top of this file, not a wait.
    if (status === 'completed' && previewUrl) {
      await deps.progress?.report(100, 'Mockup ready.');
      return { job_uuid: jobUuid, preview_url: previewUrl, design_check: designCheck };
    }
    if (Date.now() - start >= timeoutMs) {
      // Return the job so the caller can still create the product; display image self-heals later.
      await deps.progress?.report(100, 'Mockup still processing; proceeding.');
      return { job_uuid: jobUuid, preview_url: previewUrl, design_check: designCheck };
    }
    poll += 1;
    await deps.progress?.report(Math.min(90, 20 + poll * 6), `Rendering mockup (poll ${poll})...`);
    await sleep(intervalMs);
  }
}
