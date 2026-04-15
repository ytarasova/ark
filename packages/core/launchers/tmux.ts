/**
 * TmuxLauncher -- runs agent sessions in tmux.
 *
 * Extracts tmux-specific logic from session-orchestration into the
 * SessionLauncher interface. This is the default launcher for local compute.
 */

import type { SessionLauncher, LaunchResult } from "../session-launcher.js";
import type { Session, Compute } from "../../types/index.js";
import * as tmux from "../infra/tmux.js";

export class TmuxLauncher implements SessionLauncher {
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
    const tmuxName = `ark-${session.id}`;
    await tmux.createSessionAsync(tmuxName, script, {
      arkDir: opts.arkDir,
    });
    return { handle: tmuxName };
  }

  async kill(handle: string): Promise<void> {
    await tmux.killSessionAsync(handle);
  }

  async status(handle: string): Promise<"running" | "stopped" | "unknown"> {
    const exists = await tmux.sessionExistsAsync(handle);
    return exists ? "running" : "stopped";
  }

  async send(handle: string, text: string): Promise<void> {
    await tmux.sendTextAsync(handle, text);
  }

  async sendKeys(handle: string, ...keys: string[]): Promise<void> {
    await tmux.sendKeysAsync(handle, ...keys);
  }

  async capture(handle: string, lines?: number): Promise<string> {
    return tmux.capturePaneAsync(handle, { lines });
  }
}
