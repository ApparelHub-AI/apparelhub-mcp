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
      description: t.description,
      inputSchema: toJsonSchema(t.inputSchema),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
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
    return tool.handler(parsed.data, ctx);
  }
}
