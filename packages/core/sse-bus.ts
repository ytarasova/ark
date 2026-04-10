/**
 * SSE broadcast bus -- abstraction over the SSE publish/subscribe mechanism.
 *
 * Current implementation: in-memory EventEmitter-based (single process).
 * Future: RediSSEBus backed by Redis pub/sub for horizontal scaling.
 *
 * Usage:
 *   const bus = new InMemorySSEBus();
 *   const unsub = bus.subscribe("sessions", (event, data) => { ... });
 *   bus.publish("sessions", "update", { id: "s-123" });
 *   unsub(); // unsubscribe
 */

// ── Interface ──────────────────────────────────────────────────────────────

export interface SSEBus {
  /** Publish an event to a channel. */
  publish(channel: string, event: string, data: unknown): void;

  /** Subscribe to events on a channel. Returns an unsubscribe function. */
  subscribe(channel: string, callback: (event: string, data: unknown) => void): () => void;

  /** Get subscriber count for a channel (useful for diagnostics). */
  subscriberCount(channel: string): number;

  /** Remove all subscribers from all channels. */
  clear(): void;
}

// ── In-Memory Implementation ───────────────────────────────────────────────

type Listener = (event: string, data: unknown) => void;

export class InMemorySSEBus implements SSEBus {
  private _channels = new Map<string, Set<Listener>>();

  publish(channel: string, event: string, data: unknown): void {
    const listeners = this._channels.get(channel);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event, data);
      } catch {
        // Don't let one bad listener break others
      }
    }
  }

  subscribe(channel: string, callback: Listener): () => void {
    if (!this._channels.has(channel)) {
      this._channels.set(channel, new Set());
    }
    const listeners = this._channels.get(channel)!;
    listeners.add(callback);

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) {
        this._channels.delete(channel);
      }
    };
  }

  subscriberCount(channel: string): number {
    return this._channels.get(channel)?.size ?? 0;
  }

  clear(): void {
    this._channels.clear();
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an SSE bus instance. Currently always returns InMemorySSEBus.
 * When Redis support is added, this will check config and return RediSSEBus.
 */
export function createSSEBus(config?: { type?: "memory" | "redis"; redisUrl?: string }): SSEBus {
  const type = config?.type ?? "memory";
  if (type === "redis") {
    // Future: return new RediSSEBus(config.redisUrl);
    // For now, fall back to in-memory with a warning
    console.warn("Redis SSE bus not yet implemented, falling back to in-memory");
  }
  return new InMemorySSEBus();
}
