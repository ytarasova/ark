/**
 * LocalEventBus adapter -- stub.
 *
 * In Slice 1 this will delegate to the in-process `EventBus` singleton from
 * `hooks.ts`. Kept separate so the singleton can be swapped for a Redis
 * pub/sub adapter in the control-plane binding.
 */

import type { EventBus, EventHandler, BeforeHandler, ArkEvent } from "../../ports/event-bus.js";

const NOT_MIGRATED = new Error("LocalEventBus: not migrated yet -- Slice 1");

export class LocalEventBus implements EventBus {
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
