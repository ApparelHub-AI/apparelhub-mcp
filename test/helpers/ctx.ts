import { ApiClient } from '../../src/http/client.js';
import { ProgressReporter } from '../../src/progress.js';
import { Telemetry } from '../../src/telemetry.js';
import { loadConfig } from '../../src/config.js';
import type { ToolContext } from '../../src/tools/context.js';

export function fakeContext(api?: ApiClient): ToolContext {
  const config = loadConfig({ APPARELHUB_API_KEY: 'test-key' } as NodeJS.ProcessEnv);
  return {
    api:
      api ??
      new ApiClient({ apiKey: 'test-key', baseUrl: config.baseUrl, userAgent: config.userAgent }),
    progress: new ProgressReporter(),
    telemetry: new Telemetry(false),
    config,
  };
}
