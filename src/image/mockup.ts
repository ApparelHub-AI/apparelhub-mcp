import type { ApiClient } from '../http/client.js';
import { AhError } from '../errors.js';
import { asArray, isRecord, str } from '../util/shape.js';
import type { ProgressReporter } from '../progress.js';

// Mockup generation with the TWO-PHASE completion gate (Lesson 53): a job reaches
// status="completed" as soon as the provider finishes rendering, but the preview_url is only
// populated once we've mirrored the image to our S3 — which can lag. Poll the SAME job until a
// preview_url actually appears, not just until status=completed.
//
// Field names matter here (Lesson 2): the preview endpoint uses merchandise_provider_uuid +
// provider_product_ref_id + `templates`, which differ from the product-create endpoint.

export interface MockupParams {
  merchandise_provider_uuid: string;
  generated_image_uuid: string;
  provider_product_ref_id: string;
  templates: Record<string, unknown>[];
  variant_ids: number[];
}

export interface MockupResult {
  job_uuid: string;
  preview_url?: string;
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
  const timeoutMs = deps.timeoutMs ?? 30 * 60 * 1000; // Lesson 53: the second phase can lag 20+ min.
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

    if (status === 'failed') {
      throw new AhError({ code: 'mockup_failed', message: 'Mockup generation failed.', suggestion: 'Retry, or verify the design + garment.' });
    }
    // BOTH gates: status completed AND a preview_url actually populated.
    if (status === 'completed' && previewUrl) {
      await deps.progress?.report(100, 'Mockup ready.');
      return { job_uuid: jobUuid, preview_url: previewUrl };
    }
    if (Date.now() - start >= timeoutMs) {
      // Return the job so the caller can still create the product; display image self-heals later.
      await deps.progress?.report(100, 'Mockup still processing; proceeding.');
      return { job_uuid: jobUuid, preview_url: previewUrl };
    }
    poll += 1;
    await deps.progress?.report(Math.min(90, 20 + poll * 6), `Rendering mockup (poll ${poll})...`);
    await sleep(intervalMs);
  }
}
