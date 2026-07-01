import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, defineTool } from '../src/tools/registry.js';
import { fakeContext } from './helpers/ctx.js';

const echo = defineTool({
  name: 'echo',
  description: 'echo the message back',
  inputSchema: z.object({ msg: z.string() }),
  handler: async (input) => ({ echoed: input.msg }),
});

describe('ToolRegistry', () => {
  it('lists a tool with an object JSON schema and no $schema key', () => {
    const r = new ToolRegistry();
    r.register(echo);
    const [listed] = r.list();
    expect(listed?.name).toBe('echo');
    expect(listed?.inputSchema.type).toBe('object');
    expect(listed?.inputSchema).not.toHaveProperty('$schema');
  });

  it('rejects duplicate registration', () => {
    const r = new ToolRegistry();
    r.register(echo);
    expect(() => r.register(echo)).toThrow(/Duplicate/);
  });

  it('dispatch of an unknown tool -> unknown_tool', async () => {
    const r = new ToolRegistry();
    await expect(r.dispatch('nope', {}, fakeContext())).rejects.toMatchObject({
      code: 'unknown_tool',
    });
  });

  it('dispatch with invalid args -> invalid_input', async () => {
    const r = new ToolRegistry();
    r.register(echo);
    await expect(r.dispatch('echo', {}, fakeContext())).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('dispatch with valid args runs the handler', async () => {
    const r = new ToolRegistry();
    r.register(echo);
    expect(await r.dispatch('echo', { msg: 'hi' }, fakeContext())).toEqual({ echoed: 'hi' });
  });
});
