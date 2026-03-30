/**
 * SSH connection pool using OpenSSH ControlMaster multiplexing.
 *
 * One persistent master connection per host. All SSH operations (exec, rsync,
 * tunnels) multiplex over it. A semaphore limits concurrent channels.
 */

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { SSH_OPTS } from "./ssh.js";

const execFileAsync = promisify(execFile);

const CONTROL_DIR = join(homedir(), ".ark", "ssh-control");

export interface SSHPoolOpts {
  computeName: string;
  key: string;
  ip: string;
  maxConcurrent?: number;   // default 10
  controlPersist?: number;  // default 300 seconds
}

export class SSHPool {
  readonly computeName: string;
  readonly key: string;
  private ip: string;
  private socketPath: string;
  private maxConcurrent: number;
  private controlPersist: number;
  private active = 0;
  private waitQueue: Array<() => void> = [];
  private masterStarting = false;
  private closed = false;

  constructor(opts: SSHPoolOpts) {
    this.computeName = opts.computeName;
    this.key = opts.key;
    this.ip = opts.ip;
    this.maxConcurrent = opts.maxConcurrent ?? 10;
    this.controlPersist = opts.controlPersist ?? 300;
    this.socketPath = join(CONTROL_DIR, `${opts.computeName}.sock`);
    mkdirSync(CONTROL_DIR, { recursive: true });
  }

  /** Update IP (after stop/start cycle). Destroys existing master. */
  async updateIp(newIp: string): Promise<void> {
    if (newIp === this.ip) return;
    await this.destroyMaster();
    this.ip = newIp;
  }

  getIp(): string { return this.ip; }

  async isAlive(): Promise<boolean> {
    if (this.closed) return false;
    try {
      await execFileAsync("ssh", [
        "-i", this.key, "-o", `ControlPath=${this.socketPath}`,
        "-O", "check", `ubuntu@${this.ip}`,
      ], { timeout: 5_000 });
      return true;
    } catch {
      // Expected when master socket doesn't exist yet
      return false;
    }
  }

  /** Ensure the ControlMaster socket is established. */
  async connect(): Promise<void> {
    if (this.closed) throw new Error("Pool is closed");
    if (await this.isAlive()) return;
    if (this.masterStarting) {
      await new Promise<void>(r => this.waitQueue.push(r));
      return;
    }

    this.masterStarting = true;
    try {
      if (existsSync(this.socketPath)) {
        try { rmSync(this.socketPath); } catch {
          // Stale socket file may already be gone — safe to ignore
        }
      }

      await execFileAsync("ssh", [
        "-i", this.key,
        ...SSH_OPTS,
        "-o", `ControlMaster=yes`,
        "-o", `ControlPath=${this.socketPath}`,
        "-o", `ControlPersist=${this.controlPersist}`,
        "-N", "-f",
        `ubuntu@${this.ip}`,
      ], { timeout: 20_000 });
    } finally {
      this.masterStarting = false;
      const q = this.waitQueue.splice(0);
      q.forEach(r => r());
    }
  }

  /** Execute a command over the multiplexed connection. */
  async exec(cmd: string, opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.connect();
    await this.acquire();
    try {
      const { stdout } = await execFileAsync("ssh", [
        "-i", this.key,
        "-o", `ControlPath=${this.socketPath}`,
        "-o", "ControlMaster=no",
        "-o", "StrictHostKeyChecking=no",
        "-o", "LogLevel=ERROR",
        `ubuntu@${this.ip}`,
        cmd,
      ], { encoding: "utf-8", timeout: opts?.timeout ?? 30_000 });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
        exitCode: typeof err.status === "number" ? err.status : 1,
      };
    } finally {
      this.release();
    }
  }

  rsyncSshOpt(): string {
    return `ssh -i ${this.key} -o ControlPath=${this.socketPath} -o ControlMaster=no -o StrictHostKeyChecking=no`;
  }

  async rsyncPush(local: string, remote: string, opts?: { timeout?: number }): Promise<void> {
    await this.connect();
    await this.acquire();
    try {
      await execFileAsync("rsync", [
        "-avz", "--update", "--timeout=30",
        "-e", this.rsyncSshOpt(),
        local, `ubuntu@${this.ip}:${remote}`,
      ], { encoding: "utf-8", timeout: opts?.timeout ?? 300_000 });
    } catch (e: any) {
      console.error(`SSHPool.rsyncPush failed (${local} -> ${this.ip}:${remote}):`, e?.message ?? e);
    } finally {
      this.release();
    }
  }

  async rsyncPull(remote: string, local: string, opts?: { timeout?: number }): Promise<void> {
    await this.connect();
    await this.acquire();
    try {
      await execFileAsync("rsync", [
        "-avz", "--update", "--timeout=30",
        "-e", this.rsyncSshOpt(),
        `ubuntu@${this.ip}:${remote}`, local,
      ], { encoding: "utf-8", timeout: opts?.timeout ?? 300_000 });
    } catch (e: any) {
      console.error(`SSHPool.rsyncPull failed (${this.ip}:${remote} -> ${local}):`, e?.message ?? e);
    } finally {
      this.release();
    }
  }

  /** Spawn a persistent tunnel using the ControlMaster. */
  spawnTunnel(flags: string[]): void {
    const child = spawn("ssh", [
      "-i", this.key,
      "-o", `ControlPath=${this.socketPath}`,
      "-o", "ControlMaster=no",
      "-o", "StrictHostKeyChecking=no",
      "-N", "-f",
      ...flags,
      `ubuntu@${this.ip}`,
    ], { detached: true, stdio: "ignore" });
    child.unref();
  }

  /** Build args for interactive attach. */
  attachArgs(remoteCmd: string): string[] {
    return [
      "ssh", "-i", this.key,
      "-o", `ControlPath=${this.socketPath}`,
      "-o", "ControlMaster=no",
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=10",
      "-t", `ubuntu@${this.ip}`,
      remoteCmd,
    ];
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.destroyMaster();
  }

  private async destroyMaster(): Promise<void> {
    try {
      await execFileAsync("ssh", [
        "-o", `ControlPath=${this.socketPath}`,
        "-O", "exit", `ubuntu@${this.ip}`,
      ], { timeout: 5_000 });
    } catch {
      // Master may already be dead — expected during cleanup
    }
    try {
      if (existsSync(this.socketPath)) rmSync(this.socketPath);
    } catch {
      // Socket file may already be removed — safe to ignore
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>(resolve => this.waitQueue.push(resolve));
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

export function getOrCreatePool(computeName: string, key: string, ip: string): SSHPool {
  let pool = pools.get(computeName);
  if (pool) {
    if (pool.getIp() !== ip) pool.updateIp(ip);
    return pool;
  }
  pool = new SSHPool({ computeName, key, ip });
  pools.set(computeName, pool);
  return pool;
}

export async function destroyPool(computeName: string): Promise<void> {
  const pool = pools.get(computeName);
  if (pool) {
    await pool.close();
    pools.delete(computeName);
  }
}

export async function destroyAllPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map(p => p.close()));
}
