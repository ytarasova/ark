/**
 * Post-launch channel interactions: auto-accept the one-time channel
 * development prompt in the tmux pane, and deliver tasks to a running
 * Claude session via arkd or direct channel HTTP.
 */

import * as tmux from "../infra/tmux.js";
import { DEFAULT_CHANNEL_BASE_URL } from "../constants.js";
import { logInfo, logDebug } from "../observability/structured-log.js";

// ── Channel prompt auto-accept ───────────────────────────────────────────────

const CHANNEL_PROMPT_MARKERS = ["I am using this for local", "local channel development"];
/** Indicators that Claude is past all prompts and actively working. */
const CLAUDE_WORKING_MARKERS = ["ctrl+o to expand", "esc to interrupt"];

/**
 * Poll tmux pane for the channel development prompt and auto-accept it.
 *
 * The launcher may use `--resume <id> || --session-id <id>`, which causes
 * TWO Claude startups (and two channel prompts) when resume fails.
 * To handle this, we keep polling after acceptance until Claude is actually
 * working -- we don't return after the first accept.
 *
 * Four outcomes per poll:
 * 1. Prompt found -> send "1" + Enter, keep polling for a second prompt
 * 2. No prompt and Claude is working (tool use visible) -> done
 * 3. No prompt but previously accepted one -> keep polling briefly
 * 4. Neither -> keep polling (Claude still starting up)
 */
export async function autoAcceptChannelPrompt(
  tmuxName: string,
  opts?: { maxAttempts?: number; delayMs?: number },
): Promise<void> {
  const max = opts?.maxAttempts ?? 60;
  const delay = opts?.delayMs ?? 500;
  let accepted = 0;

  for (let i = 0; i < max; i++) {
    await Bun.sleep(delay);
    try {
      const output = await tmux.capturePaneAsync(tmuxName, { lines: 40 });

      // Found the channel development prompt -- accept it
      if (CHANNEL_PROMPT_MARKERS.some((m) => output.includes(m))) {
        // Option 1 is pre-selected (> prefix). Send "1" to select it,
        // brief pause, then Enter to confirm. Also try just Enter in case
        // the selection is already active.
        await tmux.sendKeysAsync(tmuxName, "1");
        await Bun.sleep(200);
        await tmux.sendKeysAsync(tmuxName, "Enter");
        await Bun.sleep(500);
        // Double-tap Enter in case the first one was swallowed
        await tmux.sendKeysAsync(tmuxName, "Enter");
        accepted++;
        continue;
      }

      // Claude is actively working -- safe to stop polling
      if (CLAUDE_WORKING_MARKERS.some((m) => output.includes(m))) {
        return;
      }

      // If we already accepted at least once and the prompt markers are gone,
      // Claude is past the prompt even if working markers haven't appeared yet
      if (accepted > 0 && !CHANNEL_PROMPT_MARKERS.some((m) => output.includes(m))) {
        return;
      }
    } catch {
      logDebug("session", "tmux pane may not exist yet during startup");
    }
  }
}

// ── Channel task delivery ────────────────────────────────────────────────────

const deliveryInFlight = new Map<string, boolean>();

/**
 * Deliver a task to a Claude session via channel.
 * Tries arkd delivery first, then falls back to direct HTTP with retry.
 */
export async function deliverTask(
  sessionId: string,
  channelPort: number,
  task: string,
  stage: string,
  opts?: { arkdUrl?: string },
): Promise<void> {
  if (deliveryInFlight.get(sessionId)) return;
  deliveryInFlight.set(sessionId, true);

  const payload = { type: "task", task, sessionId, stage };

  try {
    // Try arkd delivery first
    if (opts?.arkdUrl) {
      try {
        const { ArkdClient } = await import("../../arkd/client.js");
        const client = new ArkdClient(opts.arkdUrl);
        const result = await client.channelDeliver({ channelPort, payload });
        if (result.delivered) return;
      } catch (e: any) {
        console.error(
          `deliverTask: arkd delivery failed for session ${sessionId}, falling back to direct:`,
          e?.message ?? e,
        );
      }
    }

    // Fallback: direct HTTP to channel port with retry
    const url = `${DEFAULT_CHANNEL_BASE_URL}:${channelPort}`;
    for (let i = 0; i < 60; i++) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          return;
        }
      } catch {
        logInfo("session", "channel port not ready yet -- retry");
      }
      await Bun.sleep(1000);
    }
  } finally {
    deliveryInFlight.delete(sessionId);
  }
}
