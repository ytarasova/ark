/**
 * MCP Socket Pool — shares MCP server processes across sessions.
 *
 * Instead of each session spawning its own MCP server (N sessions x M servers = N*M processes),
 * the pool runs each MCP server once and proxies connections via Unix domain sockets.
 *
 * Architecture:
 * - SocketProxy: wraps one MCP process, accepts multiple client connections on a Unix socket
 * - Pool: manages multiple SocketProxy instances, handles health monitoring and restart
 * - Client sessions connect via: { "command": "ark", "args": ["mcp-proxy", "/tmp/ark-mcp-{name}.sock"] }
 */

import { spawn, type ChildProcess } from "child_process";
import { createServer, createConnection, type Server, type Socket } from "net";
import { existsSync, unlinkSync, readdirSync } from "fs";

// ── Types ───────────────────────────────────────────────────────────────

export interface McpServerDef {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface PoolConfig {
  enabled: boolean;
  autoStart?: boolean;
  poolAll?: boolean;
  excludeMcps?: string[];
  fallbackToStdio?: boolean;
}

type ProxyStatus = "starting" | "running" | "failed" | "stopped";

// ── SocketProxy ─────────────────────────────────────────────────────────

class SocketProxy {
  readonly name: string;
  readonly socketPath: string;
  private mcpProcess: ChildProcess | null = null;
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private requestMap = new Map<string | number, Socket>(); // JSON-RPC id → client
  private status: ProxyStatus = "stopped";
  private restartCount = 0;
  private lastRestartTime = 0;

  constructor(private def: McpServerDef) {
    this.name = def.name;
    this.socketPath = `/tmp/ark-mcp-${def.name}.sock`;
  }

  getStatus(): ProxyStatus { return this.status; }
  getClientCount(): number { return this.clients.size; }

  async start(): Promise<void> {
    if (this.status === "running") return;
    this.status = "starting";

    // Clean up stale socket
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }

    // Start MCP process
    try {
      this.mcpProcess = spawn(this.def.command, this.def.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.def.env },
      });

      if (!this.mcpProcess.stdout || !this.mcpProcess.stdin) {
        throw new Error("Failed to get MCP process stdio pipes");
      }

      // Route MCP stdout → clients
      let buffer = "";
      this.mcpProcess.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.requestMap.has(msg.id)) {
              // Routed response — send to originating client
              const client = this.requestMap.get(msg.id)!;
              this.requestMap.delete(msg.id);
              this.safeWrite(client, line + "\n");
            } else {
              // Notification — broadcast to all clients
              for (const client of this.clients) {
                this.safeWrite(client, line + "\n");
              }
            }
          } catch {
            // Non-JSON output — broadcast
            for (const client of this.clients) {
              this.safeWrite(client, line + "\n");
            }
          }
        }
      });

      this.mcpProcess.on("exit", (code) => {
        if (this.status === "running") {
          console.error(`mcp-pool: ${this.name} exited with code ${code}`);
          this.status = "failed";
        }
      });

      this.mcpProcess.stderr?.on("data", (chunk: Buffer) => {
        // Log MCP stderr for debugging
        const msg = chunk.toString().trim();
        if (msg) console.error(`mcp-pool[${this.name}]: ${msg}`);
      });

    } catch (e: any) {
      this.status = "failed";
      throw new Error(`Failed to start MCP ${this.name}: ${e.message}`);
    }

    // Start Unix socket server
    this.server = createServer((client) => {
      if (this.clients.size >= 100) {
        client.destroy();
        return;
      }

      this.clients.add(client);

      let clientBuffer = "";
      client.on("data", (chunk) => {
        clientBuffer += chunk.toString();
        let idx;
        while ((idx = clientBuffer.indexOf("\n")) !== -1) {
          const line = clientBuffer.slice(0, idx).trim();
          clientBuffer = clientBuffer.slice(idx + 1);
          if (!line) continue;

          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined) {
              this.requestMap.set(msg.id, client);
            }
          } catch { /* forward non-JSON too */ }

          // Forward to MCP stdin
          this.mcpProcess?.stdin?.write(line + "\n");
        }
      });

      client.on("close", () => {
        this.clients.delete(client);
        // Clean up request mappings for this client
        for (const [id, c] of this.requestMap) {
          if (c === client) this.requestMap.delete(id);
        }
      });

      client.on("error", () => {
        this.clients.delete(client);
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, () => {
        this.status = "running";
        resolve();
      });
      this.server!.on("error", (err) => {
        this.status = "failed";
        reject(err);
      });
    });
  }

  stop(): void {
    this.status = "stopped";

    for (const client of this.clients) {
      try { client.destroy(); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.requestMap.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    if (this.mcpProcess) {
      this.mcpProcess.kill("SIGTERM");
      setTimeout(() => {
        if (this.mcpProcess && !this.mcpProcess.killed) {
          this.mcpProcess.kill("SIGKILL");
        }
      }, 3000);
      this.mcpProcess = null;
    }

    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }
  }

  async restart(): Promise<void> {
    const now = Date.now();
    // Rate limit: min 5s between restarts, max 10 total
    if (now - this.lastRestartTime < 5000) return;
    if (this.restartCount >= 10) {
      this.status = "failed";
      console.error(`mcp-pool: ${this.name} permanently failed after ${this.restartCount} restarts`);
      return;
    }

    this.restartCount++;
    this.lastRestartTime = now;
    this.stop();
    await this.start();
  }

  private safeWrite(socket: Socket, data: string): void {
    try { if (!socket.destroyed) socket.write(data); }
    catch { /* ignore */ }
  }
}

// ── Pool ────────────────────────────────────────────────────────────────

export class McpPool {
  private proxies = new Map<string, SocketProxy>();
  private healthInterval: ReturnType<typeof setInterval> | null = null;

  /** Add an MCP server to the pool. Does not start it. */
  register(def: McpServerDef): void {
    if (!this.proxies.has(def.name)) {
      this.proxies.set(def.name, new SocketProxy(def));
    }
  }

  /** Start a pooled MCP server. */
  async start(name: string): Promise<string> {
    const proxy = this.proxies.get(name);
    if (!proxy) throw new Error(`MCP ${name} not registered`);
    await proxy.start();
    return proxy.socketPath;
  }

  /** Stop a pooled MCP server. */
  stop(name: string): void {
    this.proxies.get(name)?.stop();
  }

  /** Stop all proxies and clean up. */
  stopAll(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    for (const proxy of this.proxies.values()) {
      proxy.stop();
    }
    this.proxies.clear();
  }

  /** Start health monitoring (restart failed proxies). */
  startHealthMonitor(intervalMs: number = 3000): void {
    if (this.healthInterval) return;
    this.healthInterval = setInterval(() => {
      for (const proxy of this.proxies.values()) {
        if (proxy.getStatus() === "failed") {
          proxy.restart().catch((e) => {
            console.error(`mcp-pool: health restart failed for ${proxy.name}:`, e?.message ?? e);
          });
        }
      }
    }, intervalMs);
  }

  /** Get the socket path for a pooled MCP. Returns null if not running. */
  getSocketPath(name: string): string | null {
    const proxy = this.proxies.get(name);
    if (!proxy || proxy.getStatus() !== "running") return null;
    return proxy.socketPath;
  }

  /** Get status of all pooled MCPs. */
  getStatus(): Array<{ name: string; status: ProxyStatus; clients: number; socketPath: string }> {
    return Array.from(this.proxies.values()).map(p => ({
      name: p.name,
      status: p.getStatus(),
      clients: p.getClientCount(),
      socketPath: p.socketPath,
    }));
  }

  /** Check if an MCP is pooled and running. */
  isRunning(name: string): boolean {
    return this.proxies.get(name)?.getStatus() === "running";
  }

  /** Get the MCP config to write to .mcp.json for a pooled server. */
  getProxyConfig(name: string): { command: string; args: string[] } | null {
    const socketPath = this.getSocketPath(name);
    if (!socketPath) return null;
    return {
      command: "ark",
      args: ["mcp-proxy", socketPath],
    };
  }
}

// ── mcp-proxy CLI command (stdio ↔ socket bridge) ──────────────────────

/**
 * Bridge stdin/stdout to a Unix socket.
 * Used as the MCP server command in .mcp.json when pooling is active.
 */
export function runMcpProxy(socketPath: string): void {
  const client = createConnection(socketPath);

  client.on("connect", () => {
    process.stdin.pipe(client);
    client.pipe(process.stdout);
  });

  client.on("error", (err) => {
    console.error(`mcp-proxy: connection error: ${err.message}`);
    process.exit(1);
  });

  client.on("close", () => {
    process.exit(0);
  });
}

// ── Singleton pool ──────────────────────────────────────────────────────

let _pool: McpPool | null = null;

/** Get or create the global MCP pool. */
export function getMcpPool(): McpPool {
  if (!_pool) _pool = new McpPool();
  return _pool;
}

/** Destroy the global MCP pool. */
export function destroyMcpPool(): void {
  _pool?.stopAll();
  _pool = null;
}

/** Discover existing pool sockets on disk. */
export function discoverPoolSockets(): string[] {
  try {
    return readdirSync("/tmp")
      .filter((f: string) => f.startsWith("ark-mcp-") && f.endsWith(".sock"))
      .map((f: string) => `/tmp/${f}`);
  } catch {
    return [];
  }
}
