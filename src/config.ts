import { SERVER_VERSION } from './version.js';

// The one and only host the server ever sends an API key to (api-contract §1, tool spec §1).
// Deliberately NOT user-overridable — mirrors the skill's v2.0 security posture. There is no
// env or arg to point this elsewhere.
export const API_BASE_URL = 'https://api.apparelhub.ai/agents/v1';

export interface Config {
  /** Undefined when APPARELHUB_API_KEY is unset — the server still starts (so tools/list works),
   *  but any tool call returns `auth_required`. */
  apiKey: string | undefined;
  baseUrl: string;
  /** Client-side telemetry signal (ticket #19). Off when APPARELHUB_MCP_TELEMETRY=off. */
  telemetryEnabled: boolean;
  userAgent: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = (env.APPARELHUB_API_KEY ?? '').trim() || undefined;
  const telemetryEnabled = (env.APPARELHUB_MCP_TELEMETRY ?? '').trim().toLowerCase() !== 'off';
  return {
    apiKey,
    baseUrl: API_BASE_URL,
    telemetryEnabled,
    userAgent: `apparelhub-mcp/${SERVER_VERSION} (+https://apparelhub.ai/agents)`,
  };
}
