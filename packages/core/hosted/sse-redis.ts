/**
 * Redis-backed SSE bus -- enables horizontal scaling across multiple
 * Ark control plane instances. Uses Redis pub/sub for cross-process
 * event broadcasting.
 *
 * Usage:
 *   const bus = new RedisSSEBus("redis://localhost:6379");
 *   await bus.connect();
 *   bus.subscribe("sessions", (event, data) => { ... });
 *   bus.publish("sessions", "update", { id: "s-123" });
 *   await bus.disconnect();
 */

import { createClient, type RedisClientType } from "redis";
import type { SSEBus } from "./sse-bus.js";
import { logInfo, logDebug } from "../observability/structured-log.js";

type Listener = (event: string, data: unknown) => void;

export class RedisSSEBus implements SSEBus {
  private pub: RedisClientType;
  private sub: RedisClientType;
  private listeners = new Map<string, Set<Listener>>();

  constructor(redisUrl: string) {
    this.pub = createClient({ url: redisUrl });
    this.sub = createClient({ url: redisUrl });
  }

  async connect(): Promise<void> {
    await this.pub.connect();
    await this.sub.connect();
  }

  publish(channel: string, event: string, data: unknown): void {
    this.pub.publish(channel, JSON.stringify({ event, data }));
  }

  subscribe(channel: string, callback: Listener): () => void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
      this.sub.subscribe(channel, (message) => {
        try {
          const { event, data } = JSON.parse(message);
          for (const cb of this.listeners.get(channel) ?? []) {
            try {
              cb(event, data);
            } catch {
              logInfo("web", "Don't let one bad listener break others");
            }
          }
        } catch {
          logDebug("web", "Ignore malformed messages");
        }
      });
    }
    this.listeners.get(channel)!.add(callback);
    return () => {
      this.listeners.get(channel)?.delete(callback);
    };
  }

  subscriberCount(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }

  async disconnect(): Promise<void> {
    await this.pub.quit();
    await this.sub.quit();
  }
}
