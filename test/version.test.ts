import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SERVER_VERSION } from '../src/version.js';

describe('version', () => {
  it('SERVER_VERSION stays in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
