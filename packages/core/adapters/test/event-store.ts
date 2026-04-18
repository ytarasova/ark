/**
 * InMemoryEventStore adapter -- stub.
 *
 * Slice 1: in-memory array for unit-test audit-log assertions.
 */

import type { EventStore, EventLogOpts, EventListOpts } from "../../ports/event-store.js";
import type { Event } from "../../../types/index.js";

const NOT_MIGRATED = new Error("InMemoryEventStore: not migrated yet -- Slice 1");

export class InMemoryEventStore implements EventStore {
  setTenant(_tenantId: string): void {
    throw NOT_MIGRATED;
  }
  getTenant(): string {
    throw NOT_MIGRATED;
  }
  log(_trackId: string, _type: string, _opts?: EventLogOpts): void {
    throw NOT_MIGRATED;
  }
  list(_trackId: string, _opts?: EventListOpts): Event[] {
    throw NOT_MIGRATED;
  }
  deleteForTrack(_trackId: string): void {
    throw NOT_MIGRATED;
  }
}
