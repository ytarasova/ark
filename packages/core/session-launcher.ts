/**
 * SessionLauncher interface -- abstracts the runtime environment for agent sessions.
 *
 * Decouples session orchestration from tmux so agents can run in containers,
 * VMs, or remote hosts. Each launcher implements the same 5-method contract.
 */

import type { Session, Compute } from "../types/index.js";

export interface LaunchResult {
  /** Unique identifier for the running session (tmux name, container ID, pod name). */
  handle: string;
  /** Process ID if available. */
  pid?: number;
}

export interface SessionLauncher {
  /** Launch an agent session. Returns a handle for tracking. */
  launch(session: Session, script: string, opts: {
    env?: Record<string, string>;
    workdir?: string;
    compute?: Compute;
    arkDir?: string;
  }): Promise<LaunchResult>;

  /** Kill a running session by its handle. */
  kill(handle: string): Promise<void>;

  /** Check if a session is still running. */
  status(handle: string): Promise<"running" | "stopped" | "unknown">;

  /** Send text input to a running session. */
  send(handle: string, text: string): Promise<void>;

  /** Send raw keys to a running session (e.g. "C-c" for Ctrl+C). */
  sendKeys(handle: string, ...keys: string[]): Promise<void>;

  /** Capture output from a running session. */
  capture(handle: string, lines?: number): Promise<string>;
}
