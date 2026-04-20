/**
 * In-memory registries for legacy `ComputeProvider`s plus the new
 * `Compute` / `Runtime` kinds and warm `ComputePool`s.
 *
 * Lives on AppContext because providers are registered imperatively at
 * boot (they need a back-reference to the app). Keeping the maps + mutators
 * here keeps app.ts focused on lifecycle.
 */
import type { ComputeProvider } from "../compute/types.js";
import type { Compute as NewCompute, Runtime as NewRuntime, ComputeKind, RuntimeKind } from "../compute/core/types.js";
import type { ComputePool } from "../compute/core/pool/types.js";
import type { AppContext } from "./app.js";

export class ComputeRegistries {
  private providers = new Map<string, ComputeProvider>();
  private computes = new Map<ComputeKind, NewCompute>();
  private runtimes = new Map<RuntimeKind, NewRuntime>();
  private pools = new Map<ComputeKind, ComputePool>();

  constructor(private readonly app: AppContext) {}

  registerProvider(p: ComputeProvider): void {
    this.providers.set(p.name, p);
  }
  getProvider(name: string): ComputeProvider | null {
    return this.providers.get(name) ?? null;
  }
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  registerCompute(c: NewCompute): void {
    c.setApp?.(this.app);
    this.computes.set(c.kind, c);
  }
  registerRuntime(r: NewRuntime): void {
    r.setApp?.(this.app);
    this.runtimes.set(r.kind, r);
  }
  getCompute(k: ComputeKind): NewCompute | null {
    return this.computes.get(k) ?? null;
  }
  getRuntime(k: RuntimeKind): NewRuntime | null {
    return this.runtimes.get(k) ?? null;
  }
  listComputes(): ComputeKind[] {
    return [...this.computes.keys()];
  }
  listRuntimes(): RuntimeKind[] {
    return [...this.runtimes.keys()];
  }

  registerPool(pool: ComputePool): void {
    this.pools.set(pool.compute.kind, pool);
  }
  deregisterPool(k: ComputeKind): void {
    this.pools.delete(k);
  }
  getPool(k: ComputeKind): ComputePool | null {
    return this.pools.get(k) ?? null;
  }
  listPools(): ComputeKind[] {
    return [...this.pools.keys()];
  }
}
