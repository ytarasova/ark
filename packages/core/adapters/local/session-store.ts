/**
 * LocalSessionStore adapter -- stub.
 *
 * In Slice 1 (proper migration) this will delegate to the existing
 * `SessionRepository` class. For now the scaffolding just exposes the shape
 * so binding modules can wire it.
 */

import type { SessionStore } from "../../ports/session-store.js";
import type { Session, CreateSessionOpts, SessionListFilters } from "../../../types/index.js";

const NOT_MIGRATED = new Error("LocalSessionStore: not migrated yet -- Slice 1");

export class LocalSessionStore implements SessionStore {
  setTenant(_tenantId: string): void {
    throw NOT_MIGRATED;
  }
  getTenant(): string {
    throw NOT_MIGRATED;
  }
  get(_id: string): Session | null {
    throw NOT_MIGRATED;
  }
  create(_opts: CreateSessionOpts): Session {
    throw NOT_MIGRATED;
  }
  update(_id: string, _fields: Partial<Session>): Session | null {
    throw NOT_MIGRATED;
  }
  delete(_id: string): boolean {
    throw NOT_MIGRATED;
  }
  list(_filters?: SessionListFilters): Session[] {
    throw NOT_MIGRATED;
  }
  listDeleted(): Session[] {
    throw NOT_MIGRATED;
  }
  channelPort(_sessionId: string): number {
    throw NOT_MIGRATED;
  }
}
