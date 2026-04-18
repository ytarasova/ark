/**
 * EventBus port -- abstracts pub/sub for session lifecycle events.
 *
 * Owner: session bounded context.
 *
 * Shape lifted from the existing in-process `EventBus` class in
 * `packages/core/hooks.ts`. Re-used verbatim so the current singleton can be
 * adapted into the port with zero behaviour change.
 *
 * Local binding: the in-process `EventBus` instance from `hooks.ts`.
 * Control-plane binding: Redis pub/sub adapter (stub until multi-node).
 * Test binding: the same in-process bus with `clear()` called in `afterEach`.
 */

export interface ArkEvent {
  id: number;
  type: string;
  sessionId: string;
  stage?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export type EventHandler = (event: ArkEvent) => void | Promise<void>;
export type BeforeHandler = (event: ArkEvent) => { cancelled: boolean; reason?: string } | void;

export interface EventBus {
  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  on(type: string, handler: EventHandler): () => void;

  /** Subscribe to every event (convenience for `on("*", ...)`). */
  onAll(handler: EventHandler): () => void;

  /** Subscribe to a cancellable pre-emit hook for a given type. */
  before(type: string, handler: BeforeHandler): () => void;

  /** Emit an event. Returns false if a before-handler cancelled it. */
  emit(type: string, sessionId: string, data?: { stage?: string; data?: Record<string, unknown> }): boolean;

  /** Replay events since a given sequence id (for reconnecting clients). */
  replay(sinceId: number): ArkEvent[];

  /** Remove all handlers. Tests MUST call this in afterEach to avoid leakage. */
  clear(): void;
}
