/**
 * RedisEventBus adapter -- stub.
 *
 * Control-plane multi-node pub/sub. Replaces the in-process singleton so
 * events fan out across hosted conductor replicas. Slice 1 migration.
 */

import type { EventBus, EventHandler, BeforeHandler, ArkEvent } from "../../ports/event-bus.js";

const NOT_MIGRATED = new Error("RedisEventBus: not migrated yet -- Slice 1");

export class RedisEventBus implements EventBus {
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
