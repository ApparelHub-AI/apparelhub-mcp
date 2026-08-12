import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AhError } from '../errors.js';
import type { ToolContext } from './context.js';

export interface ToolAnnotations {
  /** Advertised MCP hint: does not modify state. */
  readOnlyHint?: boolean;
  /** Advertised MCP hint: may perform destructive updates. */
  destructiveHint?: boolean;
  /** Advertised MCP hint: repeated identical calls are safe. */
  idempotentHint?: boolean;
  /** Advertised MCP hint: interacts with external systems. */
  openWorldHint?: boolean;
}

export interface ToolDef<I = any, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
  annotations?: ToolAnnotations;
}

/** Identity helper that preserves the input/output generics for handler type-safety. */
export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete js.$schema;
  // MCP requires an object schema at the top level.
  if (js.type !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  return js;
}

/**
 * Recursively sort object keys so a fingerprint depends on CONTENT, not on the
 * order a schema generator happened to emit. Without this the same tool could
 * fingerprint differently across Node or zod versions and every client would be
 * told, falsely, that every tool had changed.
 */
function canonicalize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalize(v));
    // `required` is a SET expressed as an array, and its order follows the order
    // fields were declared in. Without sorting it, swapping two fields in a zod
    // object — a no-op refactor — changes the fingerprint and tells every client
    // that tool changed. Only `required` is sorted: order is meaningful in other
    // schema arrays (tuple `prefixItems`, for one), so a blanket sort would erase
    // real differences.
    if (key === 'required' && items.every((i) => typeof i === 'string')) {
      return [...(items as string[])].sort();
    }
    return items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k], k);
    }
    return out;
  }
  return value;
}

/**
 * A short content fingerprint over a tool's description + input schema.
 *
 * ⛔ WHY THIS IS EMBEDDED IN THE DESCRIPTION RATHER THAN REPORTED ALONE (#173).
 * The client comparing these is a language model reading text, not a program
 * computing digests. It cannot hash its own cached schemas to compare against
 * ours — that would need identical JSON Schema canonicalisation in every client
 * AND the ability to execute a hash. So the marker has to travel INSIDE the
 * artifact being versioned: a stale copy then carries a stale marker by
 * construction, and the agent compares two short strings it can literally see.
 *
 * ⚠️ Per-tool, deliberately, NOT one global server version. A global stamp would
 * change every description on every release, which resets per-tool "always
 * allow" grants across the whole surface each time and degrades exactly the
 * unattended runs this protects. A content-derived fingerprint changes only for
 * tools that actually changed — which is precisely the set that should
 * re-prompt.
 *
 * Computed from the RAW description, before the marker is appended, so it stays
 * stable rather than folding in its own output.
 */
export function toolFingerprint(def: Pick<ToolDef, 'description' | 'inputSchema'>): string {
  const material = JSON.stringify({
    description: def.description,
    schema: canonicalize(toJsonSchema(def.inputSchema)),
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 6);
}

/** How the marker is rendered into a served description and the self-report. */
export function fingerprintMarker(fingerprint: string): string {
  return `[#${fingerprint}]`;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Duplicate tool registration: ${def.name}`);
    }
    this.tools.set(def.name, def as ToolDef);
  }

  registerAll(defs: ToolDef[]): void {
    for (const d of defs) this.register(d);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  size(): number {
    return this.tools.size;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(): ListedTool[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      // The fingerprint ships INSIDE the description so a stale client holds a
      // stale marker (#173). Appended after it is computed, never folded in.
      description: `${t.description}\n\n${fingerprintMarker(toolFingerprint(t))}`,
      inputSchema: toJsonSchema(t.inputSchema),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
  }

  /** `name [#abcdef]` per tool, for the connector self-report to publish. */
  fingerprints(): string[] {
    return [...this.tools.values()]
      .map((t) => `${t.name} ${fingerprintMarker(toolFingerprint(t))}`)
      .sort();
  }

  /** Validate arguments against the tool's zod schema, then run the handler. Throws AhError
   *  on unknown tool / invalid input; the server wraps all throws into the error contract. */
  async dispatch(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AhError({ code: 'unknown_tool', message: `Unknown tool: ${name}` });
    }
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new AhError({
        code: 'invalid_input',
        message: `Invalid arguments for ${name}: ${formatZodError(parsed.error)}`,
        suggestion: 'Check the tool inputSchema and required fields.',
      });
    }
    // The registry is the only thing that knows the whole surface, so it is the
    // right place to hand it to a handler that needs it.
    return tool.handler(parsed.data, {
      ...ctx,
      toolNames: [...this.names()].sort(),
      toolFingerprints: this.fingerprints(),
    });
  }
}
