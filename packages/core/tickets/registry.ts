/**
 * Per-tenant TicketProvider registry.
 *
 * Two-layer design:
 *
 *   1. `register(kind, factory)` -- process-wide map of provider-kind ->
 *      zero-arg factory. Called once at boot when a provider package is
 *      loaded; factories are cheap and produce a fresh `TicketProvider`
 *      instance per call so per-tenant config (base URLs, HTTP clients) does
 *      not leak between tenants.
 *
 *   2. `bind(binding)` -- per-tenant binding of (tenantId, providerKind) to a
 *      credentials bundle + write-enable flag. Bindings are persisted via the
 *      injected `TicketProviderBindingRepository` so the storage backend can
 *      be swapped (in-memory now; drizzle / Postgres once the schema lands).
 *
 * `get(tenantId, kind)` assembles the runtime pair: a freshly-factoried
 * provider plus a `TicketContext` built from the binding. The context carries
 * the tenant id, credentials, and `writeEnabled` switch -- every write op in
 * the `TicketProvider` interface MUST consult `ctx.writeEnabled` and throw
 * `TicketWriteDisabledError` when it is false.
 *
 * A default in-memory repository is provided for tests and single-tenant
 * boots; the hosted control-plane will wire a persistent implementation once
 * the `ticket_provider_bindings` table migration lands (follow-up issue).
 */

import type { TicketContext, TicketCredentials, TicketProvider, TicketProviderKind } from "./types.js";

// ── Binding shape ────────────────────────────────────────────────────────────

export interface TicketProviderBinding {
  tenantId: string;
  provider: TicketProviderKind;
  credentials: TicketCredentials;
  writeEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Repository ───────────────────────────────────────────────────────────────

/**
 * Persistence contract for tenant-scoped provider bindings. Kept tiny so the
 * default in-memory implementation below and the eventual SQL implementation
 * share the same surface.
 */
export interface TicketProviderBindingRepository {
  upsert(binding: TicketProviderBinding): Promise<void>;
  delete(tenantId: string, kind: TicketProviderKind): Promise<void>;
  find(tenantId: string, kind: TicketProviderKind): Promise<TicketProviderBinding | null>;
  listByTenant(tenantId: string): Promise<TicketProviderBinding[]>;
}

/** Default in-memory repository. Not concurrent-safe across processes. */
export class InMemoryTicketProviderBindingRepository implements TicketProviderBindingRepository {
  private readonly rows = new Map<string, TicketProviderBinding>();

  private key(tenantId: string, kind: TicketProviderKind): string {
    return `${tenantId}::${kind}`;
  }

  async upsert(binding: TicketProviderBinding): Promise<void> {
    this.rows.set(this.key(binding.tenantId, binding.provider), { ...binding });
  }

  async delete(tenantId: string, kind: TicketProviderKind): Promise<void> {
    this.rows.delete(this.key(tenantId, kind));
  }

  async find(tenantId: string, kind: TicketProviderKind): Promise<TicketProviderBinding | null> {
    const row = this.rows.get(this.key(tenantId, kind));
    return row ? { ...row } : null;
  }

  async listByTenant(tenantId: string): Promise<TicketProviderBinding[]> {
    const out: TicketProviderBinding[] = [];
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId) out.push({ ...row });
    }
    return out;
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

export type TicketProviderFactory = () => TicketProvider;

export class TicketProviderRegistry {
  private readonly factories = new Map<TicketProviderKind, TicketProviderFactory>();
  private readonly bindings: TicketProviderBindingRepository;

  constructor(bindings: TicketProviderBindingRepository = new InMemoryTicketProviderBindingRepository()) {
    this.bindings = bindings;
  }

  /** Register a provider factory. Idempotent; last caller wins. */
  register(kind: TicketProviderKind, factory: TicketProviderFactory): void {
    this.factories.set(kind, factory);
  }

  /** Unregister a provider kind (process-wide). Primarily useful in tests. */
  unregister(kind: TicketProviderKind): void {
    this.factories.delete(kind);
  }

  /** Kinds this registry knows how to instantiate. */
  knownKinds(): TicketProviderKind[] {
    return [...this.factories.keys()];
  }

  /** Create or update a tenant binding. */
  async bind(binding: TicketProviderBinding): Promise<void> {
    if (!this.factories.has(binding.provider)) {
      throw new Error(
        `TicketProviderRegistry: cannot bind unknown provider kind "${binding.provider}" -- register a factory first`,
      );
    }
    await this.bindings.upsert({ ...binding });
  }

  /** Remove a tenant binding. */
  async unbind(tenantId: string, kind: TicketProviderKind): Promise<void> {
    await this.bindings.delete(tenantId, kind);
  }

  /** List bindings for a tenant. */
  async list(tenantId: string): Promise<TicketProviderBinding[]> {
    return this.bindings.listByTenant(tenantId);
  }

  /**
   * Resolve a provider + context for a tenant. Returns `null` when either
   * the factory or the binding is missing -- callers treat "no provider
   * configured" as a normal, non-error state.
   */
  async get(
    tenantId: string,
    kind: TicketProviderKind,
  ): Promise<{ provider: TicketProvider; ctx: TicketContext } | null> {
    const factory = this.factories.get(kind);
    if (!factory) return null;
    const binding = await this.bindings.find(tenantId, kind);
    if (!binding) return null;
    const provider = factory();
    const ctx: TicketContext = {
      tenantId: binding.tenantId,
      credentials: { ...binding.credentials },
      writeEnabled: binding.writeEnabled,
    };
    return { provider, ctx };
  }
}

// ── Container-backed accessor (replaces the old module-level singleton) ─────
//
// Ticket registration is wired through the awilix container's
// `ticketProviderRegistry` singleton (see `packages/core/di/runtime.ts`).
// The former module-level `_singleton` is gone; back-compat callers pass
// an AppContext and the accessor resolves from the container.

import type { AppContext } from "../app.js";

/**
 * Resolve the process-wide registry from the DI container.
 *
 * Prefer `app.container.cradle.ticketProviderRegistry` at the call site if
 * you already have it; this helper exists to keep older call sites working
 * without plumbing the container every step of the way.
 */
export function getTicketProviderRegistry(app: AppContext): TicketProviderRegistry {
  return app.container.cradle.ticketProviderRegistry;
}
