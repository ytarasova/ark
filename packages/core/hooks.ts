/**
 * Event bus with replay buffer (Goose pattern).
 *
 * Typed pub/sub for session events. Supports:
 * - Subscribe with replay (catch up on missed events)
 * - Cancellable "before" events (Pi pattern)
 * - JSON serialization for WebSocket/SSE push
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

const REPLAY_BUFFER_SIZE = 512;

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private beforeHandlers = new Map<string, Set<BeforeHandler>>();
  private buffer: ArkEvent[] = [];
  private seq = 0;

  /** Subscribe to events. Returns unsubscribe function. */
  on(type: string, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  /** Subscribe to all events */
  onAll(handler: EventHandler): () => void {
    return this.on("*", handler);
  }

  /** Subscribe to "before" events (cancellable) */
  before(type: string, handler: BeforeHandler): () => void {
    if (!this.beforeHandlers.has(type)) this.beforeHandlers.set(type, new Set());
    this.beforeHandlers.get(type)!.add(handler);
    return () => this.beforeHandlers.get(type)?.delete(handler);
  }

  /** Emit an event. Returns false if cancelled by a before handler. */
  emit(type: string, sessionId: string, data?: { stage?: string; data?: Record<string, unknown> }): boolean {
    // Check before handlers
    const beforeEvent: ArkEvent = {
      id: 0,
      type,
      sessionId,
      stage: data?.stage,
      data: data?.data,
      timestamp: new Date().toISOString(),
    };

    for (const handler of this.beforeHandlers.get(type) ?? []) {
      try {
        const result = handler(beforeEvent) as { cancelled: boolean } | void;
        if (result && result.cancelled) return false;
      } catch (e) {
        console.error(`Before handler error for ${type}:`, e);
      }
    }

    // Create event with sequence ID
    const event: ArkEvent = { ...beforeEvent, id: ++this.seq };

    // Add to replay buffer
    this.buffer.push(event);
    if (this.buffer.length > REPLAY_BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-REPLAY_BUFFER_SIZE);
    }

    // Notify handlers
    for (const handler of this.handlers.get(type) ?? []) {
      try {
        handler(event);
      } catch (e) {
        console.error(`Handler error for ${type}:`, e);
      }
    }
    for (const handler of this.handlers.get("*") ?? []) {
      try {
        handler(event);
      } catch (e) {
        console.error(`Wildcard handler error:`, e);
      }
    }

    return true;
  }

  /** Get replay events since a sequence ID (for reconnecting clients) */
  replay(sinceId: number): ArkEvent[] {
    return this.buffer.filter((e) => e.id > sinceId);
  }

  /** Clear all handlers */
  clear(): void {
    this.handlers.clear();
    this.beforeHandlers.clear();
  }
}

export const eventBus = new EventBus();
