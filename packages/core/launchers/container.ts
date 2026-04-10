/**
 * ContainerLauncher -- runs agent sessions in Docker or Kubernetes containers.
 *
 * Delegates to the ArkD client on the remote host. For v1 this is a thin
 * wrapper that calls the ArkD HTTP API for agent lifecycle operations.
 */

import type { SessionLauncher, LaunchResult } from "../session-launcher.js";
import type { Session, Compute } from "../../types/index.js";
import { ArkdClient } from "../../arkd/client.js";

export class ContainerLauncher implements SessionLauncher {
  private client: ArkdClient;

  constructor(arkdUrl: string) {
    this.client = new ArkdClient(arkdUrl);
  }

  async launch(session: Session, script: string, opts: {
    env?: Record<string, string>;
    workdir?: string;
    compute?: Compute;
    arkDir?: string;
  }): Promise<LaunchResult> {
    const sessionName = `ark-${session.id}`;
    const result = await this.client.launchAgent({
      sessionName,
      script,
      workdir: opts.workdir ?? "/workspace",
    });
    return { handle: sessionName, pid: result.pid };
  }

  async kill(handle: string): Promise<void> {
    await this.client.killAgent({ sessionName: handle });
  }

  async status(handle: string): Promise<"running" | "stopped" | "unknown"> {
    try {
      const result = await this.client.agentStatus({ sessionName: handle });
      return result.running ? "running" : "stopped";
    } catch {
      return "unknown";
    }
  }

  async send(handle: string, text: string): Promise<void> {
    // Container agents receive input via ArkD exec or channel relay.
    // For now, use the exec endpoint to echo text into the agent's stdin.
    await this.client.run({
      command: "tmux",
      args: ["send-keys", "-t", handle, text, "Enter"],
      timeout: 5_000,
    });
  }

  async sendKeys(handle: string, ...keys: string[]): Promise<void> {
    await this.client.run({
      command: "tmux",
      args: ["send-keys", "-t", handle, ...keys],
      timeout: 5_000,
    });
  }

  async capture(handle: string, lines?: number): Promise<string> {
    const result = await this.client.captureOutput({
      sessionName: handle,
      lines,
    });
    return result.output;
  }
}
