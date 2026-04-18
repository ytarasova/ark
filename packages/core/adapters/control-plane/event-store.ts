/**
 * ControlPlaneEventStore adapter -- stub.
 *
 * Hosted Postgres-backed EventRepository. Slice 1 migration.
 */

import type { EventStore, EventLogOpts, EventListOpts } from "../../ports/event-store.js";
import type { Event } from "../../../types/index.js";

const NOT_MIGRATED = new Error("ControlPlaneEventStore: not migrated yet -- Slice 1");

export class ControlPlaneEventStore implements EventStore {
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
