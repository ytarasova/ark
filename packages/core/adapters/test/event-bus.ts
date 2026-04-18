/**
 * TestEventBus adapter -- stub.
 *
 * In Slice 1 this will wrap the same in-process bus used by the local
 * binding, but expose helpers for assertions (`lastEvent`, `eventsFor`) and
 * auto-clear in `afterEach` hooks.
 */

import type { EventBus, EventHandler, BeforeHandler, ArkEvent } from "../../ports/event-bus.js";

const NOT_MIGRATED = new Error("TestEventBus: not migrated yet -- Slice 1");

export class TestEventBus implements EventBus {
  on(_type: string, _handler: EventHandler): () => void {
    throw NOT_MIGRATED;
  }
  onAll(_handler: EventHandler): () => void {
    throw NOT_MIGRATED;
  }
  before(_type: string, _handler: BeforeHandler): () => void {
    throw NOT_MIGRATED;
  }
  emit(_type: string, _sessionId: string, _data?: { stage?: string; data?: Record<string, unknown> }): boolean {
    throw NOT_MIGRATED;
  }
  replay(_sinceId: number): ArkEvent[] {
    throw NOT_MIGRATED;
  }
  clear(): void {
    throw NOT_MIGRATED;
  }
}
