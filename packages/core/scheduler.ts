/**
 * Session Scheduler -- assigns sessions to available worker nodes.
 *
 * Scheduling strategy:
 *   1. If the session requests a specific compute, find a worker on that compute.
 *   2. Otherwise, pick the least loaded available worker.
 *   3. If no workers are available, throw.
 */

import type { AppContext } from "./app.js";
import type { Session } from "../types/index.js";
import type { WorkerNode } from "./worker-registry.js";

export class SessionScheduler {
  constructor(private app: AppContext) {}

  /**
   * Schedule a session to a worker node. Returns the assigned worker.
   * Throws if no suitable worker is available.
   */
  async schedule(session: Session): Promise<WorkerNode> {
    const registry = this.app.workerRegistry;

    // 1. If session has a specific compute, find a worker for that compute
    if (session.compute_name) {
      const workers = registry.getAvailable({ computeName: session.compute_name });
      if (workers.length > 0) return this.pickBest(workers);
    }

    // 2. Find any available worker
    const available = registry.getAvailable();
    if (available.length > 0) return this.pickBest(available);

    // 3. No workers available
    throw new Error("No workers available for scheduling");
  }

  /**
   * Pick the best worker from a list of candidates.
   * Uses load ratio (active_sessions / capacity) as the primary criterion.
   */
  private pickBest(workers: WorkerNode[]): WorkerNode {
    return workers.sort((a, b) =>
      (a.active_sessions / a.capacity) - (b.active_sessions / b.capacity)
    )[0];
  }
}
