export const SERVER_NAME = '@apparelhub/mcp-server';

// npm package version. Pre-1.0 during private beta; kept in sync with package.json
// (a unit test asserts they match so they can't drift).
export const SERVER_VERSION = '0.2.3';

// The agent-facing tool-surface contract version (spec §10). Independent of the
// package semver: the surface is "v1", the package matures separately.
export const TOOL_SURFACE_VERSION = '1.0.0';
