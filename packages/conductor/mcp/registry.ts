/**
 * MCP tool registry for the Ark server daemon.
 *
 * Each tool is registered once at module-load time via `sharedRegistry.register({...})`.
 * The transport handler iterates the registry on `tools/list` and dispatches on
 * `tools/call`. Adding a new tool means: (1) define it in `tools/<group>.ts`,
 * (2) register it on `sharedRegistry`, (3) import the file from
 * `packages/conductor/mcp/index.ts` so its side-effect register runs.
 */

import type { z } from "zod";
import type { AppContext } from "../../core/app.js";
import type { TenantContext } from "../../core/auth/context.js";

export interface ToolHandlerCtx {
  app: AppContext;
  ctx: TenantContext;
}

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler: (input: I, ctx: ToolHandlerCtx) => Promise<O>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register<I, O>(def: ToolDef<I, O>): void {
    if (this.tools.has(def.name)) throw new Error(`MCP tool '${def.name}' already registered`);
    this.tools.set(def.name, def as unknown as ToolDef);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolDef | null {
    return this.tools.get(name) ?? null;
  }
}
