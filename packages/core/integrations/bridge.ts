/**
 * Messaging bridge for conductor notifications.
 * Supports Telegram and Slack for remote monitoring and control.
 */

import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";

/** Telegram getUpdates API response shape. */
interface TelegramResponse {
  ok: boolean;
  result?: Array<{
    update_id: number;
    message?: { text?: string };
  }>;
}

// ── Types ───────────────────────────────────────────────────────────────

export interface BridgeConfig {
  telegram?: {
    botToken: string;
    chatId: string;
  };
  slack?: {
    webhookUrl: string;
  };
  discord?: {
    webhookUrl: string;
  };
}

export interface BridgeMessage {
  text: string;
  source: "telegram" | "slack" | "discord" | "system";
}

type MessageHandler = (msg: BridgeMessage) => void | Promise<void>;

// ── Telegram ────────────────────────────────────────────────────────────

async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
    return resp.ok;
  } catch (e: any) {
    console.error("bridge: telegram send failed:", e?.message ?? e);
    return false;
  }
}

async function pollTelegram(token: string, onMessage: (text: string) => void, signal: AbortSignal): Promise<void> {
  let offset = 0;
  const url = `https://api.telegram.org/bot${token}/getUpdates`;

  while (!signal.aborted) {
    try {
      const resp = await fetch(`${url}?offset=${offset}&timeout=30`, { signal });
      if (!resp.ok) {
        await Bun.sleep(5000);
        continue;
      }

      const data = (await resp.json()) as TelegramResponse;
      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        const text = update.message?.text;
        if (text) onMessage(text);
      }
    } catch (e: any) {
      if (signal.aborted) return;
      console.error("bridge: telegram poll error:", e?.message ?? e);
      await Bun.sleep(5000);
    }
  }
}

// ── Slack ────────────────────────────────────────────────────────────────

async function sendSlack(webhookUrl: string, text: string): Promise<boolean> {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return resp.ok;
  } catch (e: any) {
    console.error("bridge: slack send failed:", e?.message ?? e);
    return false;
  }
}

// ── Discord ─────────────────────────────────────────────────────────

async function sendDiscord(webhookUrl: string, text: string): Promise<boolean> {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    return resp.ok;
  } catch (e: any) {
    console.error("bridge: discord send failed:", e?.message ?? e);
    return false;
  }
}

// ── Bridge ──────────────────────────────────────────────────────────────

export class Bridge {
  private config: BridgeConfig;
  private handlers: MessageHandler[] = [];
  private abortController: AbortController | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  /** Register a handler for incoming messages. */
  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /** Send a notification to all configured platforms. */
  async notify(text: string): Promise<void> {
    const promises: Promise<boolean>[] = [];

    if (this.config.telegram) {
      promises.push(sendTelegram(this.config.telegram.botToken, this.config.telegram.chatId, text));
    }
    if (this.config.slack) {
      promises.push(sendSlack(this.config.slack.webhookUrl, text));
    }
    if (this.config.discord) {
      promises.push(sendDiscord(this.config.discord.webhookUrl, text));
    }

    await Promise.allSettled(promises);
  }

  /** Send a session status notification. */
  async notifySessionStatus(session: Session, fromStatus: string, toStatus: string): Promise<void> {
    const name = session.summary ?? session.id;
    const emoji =
      toStatus === "running"
        ? "\u{1F7E2}"
        : toStatus === "waiting"
          ? "\u{1F7E1}"
          : toStatus === "completed"
            ? "\u2705"
            : toStatus === "failed"
              ? "\u{1F534}"
              : toStatus === "stopped"
                ? "\u23F9"
                : "\u26AA";

    await this.notify(`${emoji} *${name}*: ${fromStatus} \u2192 ${toStatus}`);
  }

  /** Send a summary of all session statuses. */
  async notifyStatusSummary(app?: AppContext): Promise<void> {
    let sessions: Array<{ status: string }> = [];
    if (app) {
      try {
        sessions = await app.sessions.list({ limit: 100 });
      } catch {
        logInfo("bridge", "app not booted");
      }
    }
    const counts: Record<string, number> = {};
    for (const s of sessions) {
      counts[s.status] = (counts[s.status] ?? 0) + 1;
    }

    const parts = Object.entries(counts).map(([status, count]) => `${status}: ${count}`);
    await this.notify(`\u{1F4CA} *Status summary:* ${parts.join(", ")} (${sessions.length} total)`);
  }

  /** Start listening for incoming messages (Telegram polling). */
  start(): void {
    if (this.abortController) return;
    this.abortController = new AbortController();

    if (this.config.telegram) {
      pollTelegram(
        this.config.telegram.botToken,
        (text) => {
          const msg: BridgeMessage = { text, source: "telegram" };
          for (const handler of this.handlers) {
            try {
              handler(msg);
            } catch (e: any) {
              console.error("bridge: handler error:", e?.message ?? e);
            }
          }
        },
        this.abortController.signal,
      );
    }
  }

  /** Stop listening. */
  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}

// ── Config loading ──────────────────────────────────────────────────────

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { logInfo } from "../observability/structured-log.js";

/** Load bridge config from ~/.ark/bridge.json */
export function loadBridgeConfig(arkDir?: string): BridgeConfig | null {
  if (!arkDir) return null;
  const configPath = join(arkDir, "bridge.json");
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as BridgeConfig;
  } catch (e: any) {
    console.error("bridge: failed to load config:", e?.message ?? e);
    return null;
  }
}

/** Create and start a bridge from config file. Returns null if no config. */
export function createBridge(arkDir?: string): Bridge | null {
  const config = loadBridgeConfig(arkDir);
  if (!config) return null;
  if (!config.telegram && !config.slack && !config.discord) return null;

  const bridge = new Bridge(config);
  bridge.start();
  return bridge;
}
