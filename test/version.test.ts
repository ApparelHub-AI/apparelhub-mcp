import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SERVER_VERSION } from '../src/version.js';

const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('version', () => {
  it('SERVER_VERSION stays in sync with package.json', () => {
    const pkg = readJson('../package.json');
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  // The MCP registry rejects a publish whose server.json disagrees with the npm package it
  // points at: the npm package must carry the same mcpName, and the versions must match.
  it('server.json stays in sync with package.json for the MCP registry', () => {
    const pkg = readJson('../package.json');
    const server = readJson('../server.json');
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    const npmPkg = server.packages.find((p: { registryType: string }) => p.registryType === 'npm');
    expect(npmPkg.identifier).toBe(pkg.name);
    expect(npmPkg.version).toBe(pkg.version);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
