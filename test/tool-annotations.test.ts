import { describe, expect, it } from 'vitest';
import { allTools } from '../src/tools/index.js';
import { ToolRegistry, servedAnnotations, toolFingerprint } from '../src/tools/registry.js';
import { TOOL_TITLES } from '../src/tools/titles.js';

// #196: MCP directories require every tool to carry a display title and to say
// whether it is read-only or can change data. These tests make that a build
// failure rather than something a reviewer has to notice.

function listed() {
  const r = new ToolRegistry();
  r.registerAll(allTools());
  return r.list();
}

describe('tool annotations (#196)', () => {
  it('discovers the real tool surface, not an empty list', () => {
    // A broken import would make every per-tool assertion below vacuously pass.
    expect(listed().length).toBeGreaterThan(100);
  });

  it('every tool has a non-empty title, top-level and in annotations, and they match', () => {
    for (const t of listed()) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.title.length, t.name).toBeLessThanOrEqual(64);
      expect(t.annotations?.title, t.name).toBe(t.title);
    }
  });

  it('every tool advertises exactly one of read-only or destructive', () => {
    for (const t of listed()) {
      const a = t.annotations!;
      expect(typeof a.readOnlyHint, t.name).toBe('boolean');
      expect(typeof a.destructiveHint, t.name).toBe('boolean');
      expect(a.readOnlyHint !== a.destructiveHint, t.name).toBe(true);
    }
  });

  it('tool names stay within the 64-character limit', () => {
    for (const t of listed()) expect(t.name.length, t.name).toBeLessThanOrEqual(64);
  });

  it('the titles map has no entries for tools that no longer exist', () => {
    const names = new Set(allTools().map((t) => t.name));
    const stale = Object.keys(TOOL_TITLES).filter((n) => !names.has(n));
    expect(stale).toEqual([]);
  });

  it('only an explicit readOnlyHint: true makes a tool read-only (fail-safe)', () => {
    expect(
      servedAnnotations({ name: 'list_my_stores', annotations: { readOnlyHint: true } }),
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    // Unannotated, or annotated as a non-destructive write: still advertised as able to change data.
    expect(servedAnnotations({ name: 'create_product', annotations: undefined })).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(
      servedAnnotations({
        name: 'import_channel_catalog',
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('known write tools are never advertised as read-only', () => {
    const byName = new Map(listed().map((t) => [t.name, t]));
    for (const n of [
      'api_request',
      'create_product',
      'cancel_order',
      'submit_order_to_fulfillment',
      'sync_to_channel',
      'delete_product',
      'record_order_payment',
      'check_order_status',
    ]) {
      expect(byName.get(n)?.annotations?.readOnlyHint, n).toBe(false);
    }
  });

  it('titles and hints do not change any tool fingerprint (no "always allow" resets)', () => {
    // The fingerprint is description + schema only (#173); annotations must stay out of it.
    for (const def of allTools()) {
      const withAnn = toolFingerprint(def);
      const without = toolFingerprint({ ...def, annotations: undefined } as typeof def);
      expect(withAnn, def.name).toBe(without);
    }
  });

  it('a tool with no title fails loudly instead of being listed', () => {
    const r = new ToolRegistry();
    r.register({ ...allTools()[0], name: 'brand_new_tool_without_title' });
    expect(() => r.list()).toThrow(/no display title/);
  });
});
