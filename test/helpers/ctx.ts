import { ApiClient } from '../../src/http/client.js';
import { ProgressReporter } from '../../src/progress.js';
import { Telemetry } from '../../src/telemetry.js';
import { loadConfig } from '../../src/config.js';
import type { Imaging } from '../../src/image/imaging.js';
import type { ToolContext } from '../../src/tools/context.js';

// Default imaging stub: throws if a non-design test unexpectedly reaches the local toolchain.
const throwingImaging: Imaging = {
  downloadToTemp: async () => {
    throw new Error('imaging not provided to this test');
  },
  makeTransparent: async () => {
    throw new Error('imaging not provided to this test');
  },
  readBytes: async () => {
    throw new Error('imaging not provided to this test');
  },
  imageSize: async () => undefined,
  imageStats: async () => undefined,
  ocr: async () => ({ available: false, text: '' }),
  threadColors: async () => {
    throw new Error('imaging not provided to this test');
  },
  recomposeFill: async () => {
    throw new Error('imaging not provided to this test');
  },
  cleanup: async () => {},
};

export function fakeContext(api?: ApiClient, imaging?: Imaging): ToolContext {
  const config = loadConfig({ APPARELHUB_API_KEY: 'test-key' } as NodeJS.ProcessEnv);
  return {
    api:
      api ??
      new ApiClient({ apiKey: 'test-key', baseUrl: config.baseUrl, userAgent: config.userAgent }),
    progress: new ProgressReporter(),
    telemetry: new Telemetry(false),
    config,
    imaging: imaging ?? throwingImaging,
  };
}
