/**
 * TensorZero lifecycle manager.
 *
 * Manages starting/stopping TensorZero as a Docker container (local mode)
 * or detects an existing sidecar (hosted mode). Generates config on startup,
 * waits for healthy, and tears down on stop.
 */

import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { generateTensorZeroConfig } from "./tensorzero-config.js";

export interface TensorZeroManagerOpts {
  port?: number;
  configDir?: string;
  anthropicKey?: string;
  openaiKey?: string;
  geminiKey?: string;
  postgresUrl?: string;
}

export class TensorZeroManager {
  private container: string | null = null;
  private port: number;
  private configDir: string;
  private opts: TensorZeroManagerOpts;

  constructor(opts: TensorZeroManagerOpts) {
    this.opts = opts;
    this.port = opts.port ?? 3000;
    this.configDir = opts.configDir ?? join(process.env.HOME ?? "/tmp", ".ark", "tensorzero");
  }

  /** Base URL for the TensorZero gateway. */
  get url(): string {
    return `http://localhost:${this.port}`;
  }

  /** OpenAI-compatible endpoint URL. */
  get openaiUrl(): string {
    return `${this.url}/openai/v1`;
  }

  /**
   * Start TensorZero.
   * First checks if an instance is already running (sidecar mode).
   * If not, starts a Docker container with the generated config.
   */
  async start(): Promise<void> {
    // Check if already running (sidecar mode on control plane)
    if (await this.isHealthy()) return;

    // Generate config
    mkdirSync(this.configDir, { recursive: true });
    const config = generateTensorZeroConfig({
      anthropicKey: this.opts.anthropicKey,
      openaiKey: this.opts.openaiKey,
      geminiKey: this.opts.geminiKey,
      postgresUrl: this.opts.postgresUrl,
      port: this.port,
    });
    writeFileSync(join(this.configDir, "tensorzero.toml"), config);

    // Check if Docker is available
    try {
      execFileSync("docker", ["info"], { stdio: "pipe" });
    } catch {
      throw new Error("TensorZero requires Docker. Install Docker or run TensorZero as a sidecar.");
    }

    // Stop existing container if any
    try {
      execFileSync("docker", ["rm", "-f", "ark-tensorzero"], { stdio: "pipe" });
    } catch {
      /* not running */
    }

    // Build env args
    const envArgs: string[] = [];
    if (this.opts.anthropicKey) envArgs.push("-e", `ANTHROPIC_API_KEY=${this.opts.anthropicKey}`);
    if (this.opts.openaiKey) envArgs.push("-e", `OPENAI_API_KEY=${this.opts.openaiKey}`);
    if (this.opts.geminiKey) envArgs.push("-e", `GEMINI_API_KEY=${this.opts.geminiKey}`);

    // Start container
    execFileSync("docker", [
      "run", "-d",
      "--name", "ark-tensorzero",
      "-v", `${this.configDir}:/app/config`,
      "-p", `${this.port}:${this.port}`,
      ...envArgs,
      "tensorzero/gateway",
      "--config-file", "/app/config/tensorzero.toml",
    ], { stdio: "pipe" });

    this.container = "ark-tensorzero";

    // Wait for healthy
    for (let i = 0; i < 30; i++) {
      if (await this.isHealthy()) return;
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error("TensorZero failed to start within 30s");
  }

  /** Stop TensorZero (local Docker mode only -- sidecars are not affected). */
  async stop(): Promise<void> {
    if (this.container) {
      try {
        execFileSync("docker", ["rm", "-f", this.container], { stdio: "pipe" });
      } catch {
        /* already gone */
      }
      this.container = null;
    }
  }

  /** Check if TensorZero is healthy and reachable. */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/status`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
