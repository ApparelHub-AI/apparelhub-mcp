// apparelhub-mcp#173 — a MODIFIED tool was undetectable by a client.
//
// The self-report published bare tool names, so a tool present on both sides
// whose schema or description had changed looked identical. Two failures follow,
// and the second is the worse one: the agent sends arguments its cached schema
// says are valid, and it repeats a stale description back to the operator as
// fact. Nothing errors in either case.
//
// The fix is a per-tool content fingerprint that is ALSO embedded in the served
// description, so a stale client holds a stale marker by construction and the
// comparison is one an LLM can actually do — reading two short strings, not
// computing a digest over its own cached schemas.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, defineTool, toolFingerprint } from '../src/tools/registry.js';

const tool = (name: string, description: string, inputSchema: z.ZodType) =>
  defineTool({ name, description, inputSchema, handler: async () => ({}) });

const base = () => tool('alpha', 'does alpha things', z.object({ a: z.string() }));

/** Returns the rendered marker, e.g. `[#abcdef]`, as published in the self-report. */
function markerOf(registry: ToolRegistry, name: string): string {
  const entry = registry.fingerprints().find((f) => f.startsWith(`${name} `));
  if (!entry) throw new Error(`no fingerprint for ${name}`);
  return entry.slice(name.length + 1);
}

describe('tool fingerprints', () => {
  it('changes when only the DESCRIPTION changes', () => {
    const before = toolFingerprint(base());
    const after = toolFingerprint(tool('alpha', 'does alpha things differently', z.object({ a: z.string() })));
    expect(after).not.toBe(before);
  });

  it('changes when only the SCHEMA changes', () => {
    // The real case: address1 optional -> required. Same name, same description.
    const before = toolFingerprint(
      tool('alpha', 'same words', z.object({ a: z.string().optional() })),
    );
    const after = toolFingerprint(tool('alpha', 'same words', z.object({ a: z.string() })));
    expect(after).not.toBe(before);
  });

  it('is stable when nothing changes', () => {
    expect(toolFingerprint(base())).toBe(toolFingerprint(base()));
  });

  it('does not depend on the order keys were declared in', () => {
    // Otherwise a zod or Node upgrade reshuffles keys and every client is told,
    // falsely, that every tool changed — which would train agents to ignore it.
    const one = tool('alpha', 'd', z.object({ a: z.string(), b: z.number() }));
    const two = tool('alpha', 'd', z.object({ b: z.number(), a: z.string() }));
    expect(toolFingerprint(one)).toBe(toolFingerprint(two));
  });

  it('adding an unrelated tool leaves existing fingerprints untouched', () => {
    // Churn must stay proportional to real change: a global version stamp would
    // reset every tool's always-allow grant on every release.
    const r1 = new ToolRegistry();
    r1.register(base());
    const alone = markerOf(r1, 'alpha');

    const r2 = new ToolRegistry();
    r2.register(base());
    r2.register(tool('beta', 'unrelated', z.object({ z: z.string() })));
    expect(markerOf(r2, 'alpha')).toBe(alone);
  });

  it('publishes the SAME marker in the description and in the self-report', () => {
    // The whole mechanism rests on these two matching. If they ever diverge the
    // agent is comparing two unrelated strings and would report false staleness.
    const r = new ToolRegistry();
    r.register(base());
    const [listed] = r.list();
    const marker = markerOf(r, 'alpha');
    expect(listed?.description).toContain(marker);
    expect(listed?.description).toContain('does alpha things');
  });

  it('a modified tool is now distinguishable where bare names were identical', () => {
    // The regression this exists to prevent, stated end to end.
    const before = new ToolRegistry();
    before.register(base());
    const after = new ToolRegistry();
    after.register(tool('alpha', 'does alpha things', z.object({ a: z.string(), b: z.number() })));

    expect(after.names()).toEqual(before.names()); // bare names cannot tell
    expect(after.fingerprints()).not.toEqual(before.fingerprints()); // fingerprints can
  });
});
