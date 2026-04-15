/**
 * Reliable message sending to tmux sessions.
 * Retries with paste marker detection and readiness gating.
 */

import * as tmux from "./infra/tmux.js";

export interface SendOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  waitForReady?: boolean;
  readyTimeoutMs?: number;
}

const DEFAULT_OPTS: Required<SendOptions> = {
  maxRetries: 5,
  retryDelayMs: 1000,
  waitForReady: true,
  readyTimeoutMs: 30_000,
};

/**
 * Check if the tmux pane has an unsent paste marker.
 * Claude shows "[Pasted text #N +M lines]" when text is pasted but not submitted.
 */
export function hasPasteMarker(content: string): boolean {
  return /\[Pasted text #\d+/.test(content);
}

/**
 * Check if the session appears ready for input.
 * Looks for a prompt character (> or $) on the last non-empty line.
 */
export function isReadyForInput(content: string): boolean {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return false;
  const lastLine = lines[lines.length - 1].trim();
  return lastLine.endsWith(">") || lastLine.endsWith("$") || lastLine.endsWith("%");
}

/**
 * Send a message to a tmux session with retry logic.
 *
 * 1. Optionally waits for the session to be ready (prompt visible)
 * 2. Sends the message via tmux send-keys
 * 3. Checks for paste markers (delivery failure indicator)
 * 4. Retries with Enter key nudge if paste marker detected
 */
export async function sendReliable(
  sessionName: string,
  message: string,
  opts?: SendOptions,
): Promise<{ ok: boolean; attempts: number; message: string }> {
  const o = { ...DEFAULT_OPTS, ...opts };

  // 1. Wait for readiness
  if (o.waitForReady) {
    const deadline = Date.now() + o.readyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const content = await tmux.capturePaneAsync(sessionName, { lines: 10 });
        if (isReadyForInput(content)) break;
      } catch {
        /* session may not exist yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 2. Send message
  await tmux.sendTextAsync(sessionName, message);

  // 3. Verify delivery with retry
  for (let attempt = 1; attempt <= o.maxRetries; attempt++) {
    await new Promise((r) => setTimeout(r, o.retryDelayMs));

    try {
      const content = await tmux.capturePaneAsync(sessionName, { lines: 20 });

      // Check for paste marker (message stuck in composer)
      if (hasPasteMarker(content)) {
        // Nudge with a bare Enter to submit the pasted text.
        // Avoid re-entering the full load/paste pipeline via sendTextAsync("").
        await tmux.sendKeysAsync(sessionName, "Enter");
        continue;
      }

      // If no paste marker, assume delivered
      return { ok: true, attempts: attempt, message: "Delivered" };
    } catch (e: any) {
      // Session might have died
      if (attempt === o.maxRetries) {
        return { ok: false, attempts: attempt, message: `Session unreachable: ${e?.message ?? e}` };
      }
    }
  }

  return { ok: false, attempts: o.maxRetries, message: "Max retries exceeded" };
}
