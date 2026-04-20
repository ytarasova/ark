/**
 * QueryMethod -- one named, scoped, cost-tagged way to read from the store.
 *
 * A query method is discoverable (CLI + MCP + RPC inject from the registry),
 * tagged with its cost (so callers can budget), and gated by a scope that
 * policies can inspect.
 *
 * Example:
 *   const search: QueryMethod<{ q: string }, SearchHit[]> = {
 *     name: "search",
 *     scope: "read",
 *     cost: "cheap",
 *     async run(ctx, args) {
 *       return ctx.store.ftsSearch(ctx.tenant_id, args.q);
 *     },
 *   };
 */

import type { CodeIntelStore } from "../store.js";

export interface QueryContext {
  tenant_id: string;
  repo_id?: string;
  branch?: string;
  commit?: string;
  store: CodeIntelStore;
}

/** Cost hint: callers can refuse heavy queries when on a budget. */
export type QueryCost = "cheap" | "moderate" | "heavy";

/** Scope hint: policies gate admin-scope methods separately from read. */
export type QueryScope = "read" | "admin";

export interface QueryExplanation {
  /** Structured breakdown of what happened: chosen strategy, rows scanned, timings. */
  trace: Record<string, unknown>;
}

export interface QueryMethod<Args, Result> {
  readonly name: string;
  readonly scope: QueryScope;
  readonly cost: QueryCost;
  run(ctx: QueryContext, args: Args): Promise<Result>;
  /**
   * Optional explainability hook. Wave 1 queries implement run() only;
   * D9 (explainable ranking) fills these in.
   */
  explain?(ctx: QueryContext, args: Args): Promise<QueryExplanation>;
}

/** Registry of query methods keyed by name. */
export class QueryRegistry {
  private readonly methods = new Map<string, QueryMethod<any, any>>();

  register<A, R>(method: QueryMethod<A, R>): void {
    if (this.methods.has(method.name)) {
      throw new Error(`QueryMethod already registered: ${method.name}`);
    }
    this.methods.set(method.name, method);
  }

  get<A = unknown, R = unknown>(name: string): QueryMethod<A, R> | null {
    return (this.methods.get(name) as QueryMethod<A, R> | undefined) ?? null;
  }

  list(): QueryMethod<any, any>[] {
    return Array.from(this.methods.values());
  }
}
