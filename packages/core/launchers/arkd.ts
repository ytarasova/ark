/**
 * ArkdLauncher -- runs agent sessions on remote compute via the ArkD HTTP API.
 *
 * Used for EC2, remote Docker, Firecracker, and any compute target that
 * runs an arkd daemon. The launcher delegates all operations to the remote
 * arkd instance over HTTP.
 */

import type { SessionLauncher, LaunchResult } from "../session-launcher.js";
import type { Session, Compute } from "../../types/index.js";
import { ArkdClient } from "../../arkd/client.js";

export class ArkdLauncher implements SessionLauncher {
  private client: ArkdClient;

  constructor(arkdUrl: string);
  constructor(client: ArkdClient);
  constructor(urlOrClient: string | ArkdClient) {
    this.client = typeof urlOrClient === "string" ? new ArkdClient(urlOrClient) : urlOrClient;
  }

  async launch(
    session: Session,
    script: string,
    opts: {
      env?: Record<string, string>;
      workdir?: string;
      compute?: Compute;
      arkDir?: string;
    },
  ): Promise<LaunchResult> {
    const sessionName = `ark-${session.id}`;
    const result = await this.client.launchAgent({
      sessionName,
      script,
      workdir: opts.workdir ?? "/home/ubuntu/workspace",
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
    // Use ArkD exec to send text via tmux on the remote host
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
