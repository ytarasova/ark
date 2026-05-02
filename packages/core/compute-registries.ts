/**
 * In-memory registries for legacy `ComputeProvider`s plus the new
 * `Compute` / `Isolation` kinds and warm `ComputePool`s.
 *
 * Lives on AppContext because providers are registered imperatively at
 * boot. Keeping the maps + mutators here keeps app.ts focused on lifecycle.
 */
import type { ComputeProvider } from "../compute/types.js";
import type {
  Compute as NewCompute,
  Isolation as NewIsolation,
  ComputeKind,
  IsolationKind,
} from "../compute/core/types.js";
import type { ComputePool } from "../compute/core/pool/types.js";

export class ComputeRegistries {
  private providers = new Map<string, ComputeProvider>();
  private computes = new Map<ComputeKind, NewCompute>();
  private isolations = new Map<IsolationKind, NewIsolation>();
  private pools = new Map<ComputeKind, ComputePool>();

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
    this.computes.set(c.kind, c);
  }
  registerIsolation(r: NewIsolation): void {
    this.isolations.set(r.kind, r);
  }
  getCompute(k: ComputeKind): NewCompute | null {
    return this.computes.get(k) ?? null;
  }
  getIsolation(k: IsolationKind): NewIsolation | null {
    return this.isolations.get(k) ?? null;
  }
  listComputes(): ComputeKind[] {
    return [...this.computes.keys()];
  }
  listIsolations(): IsolationKind[] {
    return [...this.isolations.keys()];
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
