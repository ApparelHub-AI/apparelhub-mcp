import { describe, it, expect } from 'vitest';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('createServer', () => {
  it('registers the tool surface', () => {
    const { registry } = createServer(loadConfig({} as NodeJS.ProcessEnv));
    expect(registry.has('list_my_stores')).toBe(true);
    expect(registry.list().length).toBeGreaterThan(0);
  });

  it('every listed tool advertises an object input schema', () => {
    const { registry } = createServer(loadConfig({} as NodeJS.ProcessEnv));
    for (const tool of registry.list()) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});
