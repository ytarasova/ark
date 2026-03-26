/**
 * Per-type SSH operation queues.
 *
 * Each queue type has its own channel so different payload types don't block
 * each other. Metrics uses drop-newest (never accumulates stale requests).
 * Commands and sync use FIFO.
 */

import type { SSHPool } from "./pool.js";

export class SSHQueue {
  private pool: SSHPool;

  // Metrics: drop-newest — only one in-flight at a time
  private metricsInFlight = false;

  // Commands: FIFO chain
  private commandTail: Promise<void> = Promise.resolve();

  // Sync: FIFO chain (separate so long rsyncs don't block short commands)
  private syncTail: Promise<void> = Promise.resolve();

  constructor(pool: SSHPool) {
    this.pool = pool;
  }

  /**
   * Metrics queue — drop-newest policy.
   * Returns null immediately if a metrics fetch is already in flight.
   * This prevents accumulation when SSH is slow.
   */
  async metrics<T>(fn: (pool: SSHPool) => Promise<T>): Promise<T | null> {
    if (this.metricsInFlight) return null;
    this.metricsInFlight = true;
    try {
      return await fn(this.pool);
    } finally {
      this.metricsInFlight = false;
    }
  }

  /**
   * Command queue — FIFO.
   * Used for: clone, upload configs, launch tmux, kill agent, capture output.
   */
  async command<T>(fn: (pool: SSHPool) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.commandTail = this.commandTail.then(
        () => fn(this.pool).then(resolve, reject),
        () => fn(this.pool).then(resolve, reject),
      );
    });
  }

  /**
   * Sync queue — FIFO, separate from commands.
   * Used for: rsync push/pull, credential sync, project file sync.
   */
  async sync<T>(fn: (pool: SSHPool) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.syncTail = this.syncTail.then(
        () => fn(this.pool).then(resolve, reject),
        () => fn(this.pool).then(resolve, reject),
      );
    });
  }

  stats(): { metricsInFlight: boolean } {
    return { metricsInFlight: this.metricsInFlight };
  }
}
