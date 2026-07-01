import type { ApiClient } from '../http/client.js';
import type { ProgressReporter } from '../progress.js';
import type { Telemetry } from '../telemetry.js';
import type { Config } from '../config.js';
import type { Imaging } from '../image/imaging.js';

/** Everything a tool handler needs, injected per call. Keeps handlers pure + unit-testable
 *  (tests pass a mock ApiClient + a no-op ProgressReporter + a fake Imaging). */
export interface ToolContext {
  api: ApiClient;
  progress: ProgressReporter;
  telemetry: Telemetry;
  config: Config;
  /** Local image toolchain (download/transparency/OCR). Used by the design tools. */
  imaging: Imaging;
  signal?: AbortSignal;
}
