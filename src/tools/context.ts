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
  /** Raw fetch for endpoints OUTSIDE the ApparelHub API — fetching a caller's
   *  source_url and PUTting to a presigned storage URL (upload_design). Never
   *  carries our API key. Injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Injectable so tests do not actually wait between status polls. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable clock, so poll-timeout behaviour is testable. */
  nowImpl?: () => number;
  /** Every tool name THIS server serves, injected by the registry at call time.
   *  Lets `get_api_reference` report the real surface so a client can tell a
   *  stale tool list from a missing feature. Injected rather than imported: the
   *  registry already owns the list, and importing it back into a tool module
   *  would be a cycle that survives unit tests and breaks the bundled build. */
  toolNames?: string[];
}
