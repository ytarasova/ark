/**
 * NoopLauncher -- stubbed SessionLauncher for tests.
 *
 * Records launch/kill/send calls in memory and returns synthetic handles so
 * unit tests exercising `session/start` (which atomically dispatches the
 * first stage) don't spawn real tmux panes + claude CLIs. Without this,
 * every auto-dispatched test session leaks an ark-s-* tmux session and a
 * live claude process into the user's shell environment.
 *
 * Installed by `AppContext.forTest` / `forTestAsync`; production code keeps
 * the real `TmuxLauncher`.
 */

import type { SessionLauncher, LaunchResult } from "../session-launcher.js";
import type { Session, Compute } from "../../types/index.js";

export class NoopLauncher implements SessionLauncher {
  readonly launches: Array<{ sessionId: string; script: string; workdir?: string }> = [];
  readonly kills: string[] = [];

  async launch(
    session: Session,
    script: string,
    opts: { env?: Record<string, string>; workdir?: string; compute?: Compute; arkDir?: string },
  ): Promise<LaunchResult> {
    const handle = `noop-${session.id}`;
    this.launches.push({ sessionId: session.id, script, workdir: opts.workdir });
    return { handle, pid: 0 };
  }

  async kill(handle: string): Promise<void> {
    this.kills.push(handle);
  }

  async status(): Promise<"running" | "stopped" | "unknown"> {
    return "running";
  }

  async send(): Promise<void> {}

  async sendKeys(): Promise<void> {}

  async capture(): Promise<string> {
    return "";
  }
}
