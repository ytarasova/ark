/**
 * TensorZero lifecycle manager.
 *
 * Start order:
 * 1. Sidecar mode -- detect existing instance (control plane / docker-compose)
 * 2. Native binary -- vendored binary at bin/tensorzero-gateway next to ark
 * 3. Docker fallback -- Docker container (only if native binary not found)
 *
 * Local mode prefers native binary so no Docker dependency is required.
 */

import { spawn, execFileSync, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { generateTensorZeroConfig } from "./tensorzero-config.js";
import { logInfo, logDebug } from "../observability/structured-log.js";

export interface TensorZeroManagerOpts {
  port?: number;
  /**
   * Directory for `tensorzero.toml`. Required -- callers must supply an
   * ark-controlled path (typically `app.config.arkDir`). The previous
   * fallback to `$HOME/.ark/tensorzero` or `/tmp/.ark/tensorzero` leaked
   * provider API keys into arbitrary host locations; in shared-host /
   * container deployments `/tmp` is world-readable and the container user
   * often has no real `$HOME`.
   */
  configDir: string;
  /** Path to vendored binary. Auto-detected from ark binary location if omitted. */
  binaryPath?: string;
  anthropicKey?: string;
  openaiKey?: string;
  geminiKey?: string;
  postgresUrl?: string;
}

export class TensorZeroManager {
  private process: ChildProcess | null = null;
  private container: string | null = null;
  private port: number;
  private configDir: string;
  private opts: TensorZeroManagerOpts;

  constructor(opts: TensorZeroManagerOpts) {
    if (!opts.configDir) {
      throw new Error("TensorZeroManager requires an explicit configDir (no `$HOME` / `/tmp` fallback)");
    }
    this.opts = opts;
    this.port = opts.port ?? 3000;
    this.configDir = opts.configDir;
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
   * Start TensorZero. Tries in order:
   * 1. Sidecar -- if already running, use it
   * 2. Native binary -- vendored or in PATH
   * 3. Docker container -- fallback
   */
  async start(): Promise<void> {
    // 1. Sidecar mode: already running (control plane, docker-compose)
    if (await this.isHealthy()) return;

    // Generate config
    const configPath = this.writeConfig();

    // 2. Try native binary
    const binary = this.findBinary();
    if (binary) {
      await this.startNative(binary, configPath);
      return;
    }

    // 3. Docker fallback
    await this.startDocker(configPath);
  }

  /** Stop TensorZero (native process or Docker container). Sidecars are not affected. */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    if (this.container) {
      try {
        execFileSync("docker", ["rm", "-f", this.container], { stdio: "pipe" });
      } catch {
        logDebug("general", "already gone");
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

  // ── Private ────────────────────────────────────────────────────────────────

  private writeConfig(): string {
    mkdirSync(this.configDir, { recursive: true });
    const configPath = join(this.configDir, "tensorzero.toml");
    const config = generateTensorZeroConfig({
      anthropicKey: this.opts.anthropicKey,
      openaiKey: this.opts.openaiKey,
      geminiKey: this.opts.geminiKey,
      postgresUrl: this.opts.postgresUrl,
      port: this.port,
    });
    // chmod 600 on the config: it embeds the Anthropic / OpenAI / Gemini
    // API keys + the Postgres URL. Any other user on the same host MUST
    // NOT read it. `writeFileSync` honours the mode flag on first create,
    // and `chmodSync` re-applies on existing files (defense in depth for
    // container restarts that reuse the volume).
    writeFileSync(configPath, config, { mode: 0o600 });
    try {
      chmodSync(configPath, 0o600);
    } catch (e: any) {
      logDebug("router", `tensorzero.toml chmod 600 failed: ${e?.message ?? e}`);
    }
    return configPath;
  }

  /**
   * Find the tensorzero-gateway binary.
   * Search order:
   * 1. Explicit binaryPath from opts
   * 2. bin/tensorzero-gateway next to the ark binary (vendored in tarball)
   * 3. tensorzero-gateway in PATH
   */
  private findBinary(): string | null {
    // Explicit path
    if (this.opts.binaryPath && existsSync(this.opts.binaryPath)) {
      return this.opts.binaryPath;
    }

    // Next to ark binary (vendored distribution)
    const arkBin = process.argv[0];
    if (arkBin) {
      const vendored = join(dirname(arkBin), "tensorzero-gateway");
      if (existsSync(vendored)) return vendored;
    }

    // In PATH
    try {
      const which = execFileSync("which", ["tensorzero-gateway"], { stdio: "pipe" }).toString().trim();
      if (which && existsSync(which)) return which;
    } catch {
      logDebug("general", "not in PATH");
    }

    return null;
  }

  private async startNative(binary: string, configPath: string): Promise<void> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (this.opts.anthropicKey) env.ANTHROPIC_API_KEY = this.opts.anthropicKey;
    if (this.opts.openaiKey) env.OPENAI_API_KEY = this.opts.openaiKey;
    if (this.opts.geminiKey) env.GEMINI_API_KEY = this.opts.geminiKey;

    this.process = spawn(binary, ["--config-file", configPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.process.on("error", (err) => {
      console.error(`[tensorzero] Process error: ${err.message}`);
    });

    this.process.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`[tensorzero] Process exited with code ${code}`);
      }
      this.process = null;
    });

    await this.waitForHealthy(15);
  }

  private async startDocker(configPath: string): Promise<void> {
    // Check if Docker is available
    try {
      execFileSync("docker", ["info"], { stdio: "pipe" });
    } catch {
      throw new Error(
        "TensorZero gateway not found. Either:\n" +
          "  - Install the vendored binary (in bin/tensorzero-gateway)\n" +
          "  - Install Docker and try again\n" +
          "  - Run TensorZero as a sidecar (control plane mode)",
      );
    }

    // Stop existing container if any
    try {
      execFileSync("docker", ["rm", "-f", "ark-tensorzero"], { stdio: "pipe" });
    } catch {
      logInfo("general", "not running");
    }

    const envArgs: string[] = [];
    if (this.opts.anthropicKey) envArgs.push("-e", `ANTHROPIC_API_KEY=${this.opts.anthropicKey}`);
    if (this.opts.openaiKey) envArgs.push("-e", `OPENAI_API_KEY=${this.opts.openaiKey}`);
    if (this.opts.geminiKey) envArgs.push("-e", `GEMINI_API_KEY=${this.opts.geminiKey}`);

    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        "ark-tensorzero",
        "-v",
        `${dirname(configPath)}:/app/config`,
        "-p",
        `${this.port}:${this.port}`,
        ...envArgs,
        "tensorzero/gateway",
        "--config-file",
        "/app/config/tensorzero.toml",
      ],
      { stdio: "pipe" },
    );

    this.container = "ark-tensorzero";
    await this.waitForHealthy(30);
  }

  private async waitForHealthy(timeoutSecs: number): Promise<void> {
    for (let i = 0; i < timeoutSecs; i++) {
      if (await this.isHealthy()) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`TensorZero failed to become healthy within ${timeoutSecs}s`);
  }
}
