/**
 * LocalEventStore adapter.
 *
 * Delegates to the existing SQLite-backed `EventRepository`. Tenant scoping
 * is forwarded to the underlying repository on setTenant().
 */

import type { EventStore, EventLogOpts, EventListOpts } from "../../ports/event-store.js";
import type { Event } from "../../../types/index.js";
import { EventRepository } from "../../repositories/event.js";
import type { IDatabase } from "../../database/index.js";

export class LocalEventStore implements EventStore {
  private repo: EventRepository;

  constructor(db: IDatabase) {
    this.repo = new EventRepository(db);
  }

  setTenant(tenantId: string): void {
    this.repo.setTenant(tenantId);
  }

  getTenant(): string {
    return this.repo.getTenant();
  }

  log(trackId: string, type: string, opts?: EventLogOpts): void {
    this.repo.log(trackId, type, opts);
  }

  list(trackId: string, opts?: EventListOpts): Event[] {
    return this.repo.list(trackId, opts);
  }

  deleteForTrack(trackId: string): void {
    this.repo.deleteForTrack(trackId);
  }
}
