/**
 * InMemoryEventStore adapter.
 *
 * In-memory array implementation for unit-test audit-log assertions.
 * Tenant scoping is enforced by filtering on the active tenant.
 */

import type { EventStore, EventLogOpts, EventListOpts } from "../../ports/event-store.js";
import type { Event } from "../../../types/index.js";

interface StoredEvent extends Event {
  tenant_id: string;
}

export class InMemoryEventStore implements EventStore {
  private rows: StoredEvent[] = [];
  private tenantId: string = "default";
  private nextId = 1;

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }

  getTenant(): string {
    return this.tenantId;
  }

  async log(trackId: string, type: string, opts?: EventLogOpts): Promise<void> {
    const row: StoredEvent = {
      id: this.nextId++,
      track_id: trackId,
      type,
      stage: opts?.stage ?? null,
      actor: opts?.actor ?? null,
      data: opts?.data ? { ...opts.data } : null,
      created_at: new Date().toISOString(),
      tenant_id: this.tenantId,
    };
    this.rows.push(row);
  }

  async list(trackId: string, opts?: EventListOpts): Promise<Event[]> {
    const limit = opts?.limit ?? 200;
    const filtered = this.rows.filter((r) => {
      if (r.track_id !== trackId) return false;
      if (r.tenant_id !== this.tenantId) return false;
      if (opts?.type && r.type !== opts.type) return false;
      return true;
    });
    filtered.sort((a, b) => a.id - b.id);
    return filtered.slice(0, limit).map((r) => {
      const { tenant_id: _tid, ...event } = r;
      return event;
    });
  }

  async deleteForTrack(trackId: string): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.track_id === trackId && r.tenant_id === this.tenantId));
  }
}
