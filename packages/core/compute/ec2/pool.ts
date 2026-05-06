/**
 * SSM-backed exec pool for EC2 hosts.
 *
 * Originally an SSH ControlMaster multiplexer; under pure SSM there's no
 * persistent socket to keep alive -- SendCommand is independent per call.
 * This module is preserved as a thin adapter so legacy callers keep
 * working: it bounds in-flight calls with a semaphore but otherwise
 * delegates to the SSM helpers.
 *
 * Port-forward management lives on the EC2Compute helper surface (see
 * core/ec2.ts:DEFAULT_HELPERS.startPortForward / killPortForward). The
 * pool's `spawnTunnel` / `attachArgs` shapes were SSH-specific and have
 * been removed -- callers that need a forward should call ssmStartPortForward
 * directly.
 */

import { ssmExec, type SsmConnectOpts } from "./ssm.js";
import { logDebug } from "../../observability/structured-log.js";

/** Default timeout for SSM command execution */
const SSM_EXEC_TIMEOUT_MS = 30_000;

export interface SSHPoolOpts {
  computeName: string;
  instanceId: string;
  ssm: SsmConnectOpts;
  maxConcurrent?: number; // default 10
}

/**
 * SSM-backed exec pool. The class name is preserved for back-compat with
 * legacy callers; under the hood it's now a SendCommand semaphore -- there
 * is no SSH process to multiplex.
 */
export class SSHPool {
  readonly computeName: string;
  private instanceId: string;
  private ssm: SsmConnectOpts;
  private maxConcurrent: number;
  private active = 0;
  private waitQueue: Array<() => void> = [];
  private closed = false;

  constructor(opts: SSHPoolOpts) {
    this.computeName = opts.computeName;
    this.instanceId = opts.instanceId;
    this.ssm = opts.ssm;
    this.maxConcurrent = opts.maxConcurrent ?? 10;
  }

  /** Update target instance_id (after stop/start cycle). */
  async updateTarget(newInstanceId: string, newSsm?: SsmConnectOpts): Promise<void> {
    if (newInstanceId === this.instanceId && (!newSsm || newSsm === this.ssm)) return;
    this.instanceId = newInstanceId;
    if (newSsm) this.ssm = newSsm;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * "Alive" under SSM means the agent reports Online. We don't probe per
   * call; callers that want a connectivity check should use
   * `ssmCheckInstance` directly.
   */
  async isAlive(): Promise<boolean> {
    return !this.closed;
  }

  /** No-op under SSM (kept for back-compat with the legacy ControlMaster API). */
  async connect(): Promise<void> {
    if (this.closed) throw new Error("Pool is closed");
  }

  /** Execute a command via SSM SendCommand. */
  async exec(cmd: string, opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.closed) throw new Error("Pool is closed");
    await this.acquire();
    try {
      return await ssmExec({
        instanceId: this.instanceId,
        region: this.ssm.region,
        awsProfile: this.ssm.awsProfile,
        command: cmd,
        timeoutMs: opts?.timeout ?? SSM_EXEC_TIMEOUT_MS,
      });
    } finally {
      this.release();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    logDebug("pool", "ssm pool closed (no socket to tear down)");
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.waitQueue.shift();
    if (next) next();
  }
}

// ── Pool Registry ──────────────────────────────────────────────────────────

const pools = new Map<string, SSHPool>();

export function getPool(computeName: string): SSHPool | undefined {
  return pools.get(computeName);
}

export function getOrCreatePool(computeName: string, instanceId: string, ssm: SsmConnectOpts): SSHPool {
  let pool = pools.get(computeName);
  if (pool) {
    if (pool.getInstanceId() !== instanceId) pool.updateTarget(instanceId, ssm);
    return pool;
  }
  pool = new SSHPool({ computeName, instanceId, ssm });
  pools.set(computeName, pool);
  return pool;
}

export async function destroyPool(computeName: string): Promise<void> {
  const pool = pools.get(computeName);
  if (!pool) return;
  await pool.close();
  pools.delete(computeName);
}

export async function destroyAllPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.close()));
}
