/**
 * Messaging bridge for conductor notifications.
 * Supports Slack (webhook) and email (SMTP) for remote monitoring.
 */

import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";

// ── Types ───────────────────────────────────────────────────────────────

export interface BridgeConfig {
  slack?: {
    webhookUrl: string;
  };
  email?: {
    /** SMTP host (e.g. "smtp.gmail.com", "smtp-mail.outlook.com"). */
    host: string;
    port: number;
    /** Whether to use STARTTLS/implicit TLS. Matches nodemailer's `secure` field. */
    secure?: boolean;
    auth?: {
      user: string;
      pass: string;
    };
    /** Envelope sender (From: header). */
    from: string;
    /** Recipient list for notifications. */
    to: string | string[];
  };
}

export interface BridgeMessage {
  text: string;
  source: "slack" | "email" | "system";
}

type MessageHandler = (msg: BridgeMessage) => void | Promise<void>;

// 10s cap is enough for a healthy slack webhook or SMTP handshake; beyond
// that the caller would rather see a dropped notification than a stall.
const NOTIFY_TIMEOUT_MS = 10_000;

// ── Slack ────────────────────────────────────────────────────────────────

async function sendSlack(webhookUrl: string, text: string): Promise<boolean> {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    return resp.ok;
  } catch (e: any) {
    console.error("bridge: slack send failed:", e?.message ?? e);
    return false;
  }
}

// ── Email (SMTP via nodemailer) ──────────────────────────────────────────

async function sendEmail(cfg: NonNullable<BridgeConfig["email"]>, text: string): Promise<boolean> {
  try {
    // Late import so the nodemailer module graph only loads when email is
    // actually configured -- keeps the control-plane cold-start cheap.
    const { createTransport } = await import("nodemailer");
    const transport = createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure ?? cfg.port === 465,
      auth: cfg.auth,
      connectionTimeout: NOTIFY_TIMEOUT_MS,
      greetingTimeout: NOTIFY_TIMEOUT_MS,
      socketTimeout: NOTIFY_TIMEOUT_MS,
    });
    const subject = text.split("\n")[0].slice(0, 120);
    await transport.sendMail({
      from: cfg.from,
      to: cfg.to,
      subject,
      text,
    });
    transport.close();
    return true;
  } catch (e: any) {
    console.error("bridge: email send failed:", e?.message ?? e);
    return false;
  }
}

// ── Bridge ──────────────────────────────────────────────────────────────

export class Bridge {
  private config: BridgeConfig;
  private handlers: MessageHandler[] = [];
  private running = false;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  /**
   * Register a handler for incoming messages. Neither slack nor email offer
   * a bidirectional inbound channel in this bridge, so handlers fire only
   * for programmatic `system` messages today. Kept so callers can wire one
   * uniform listener and not care which channels are live.
   */
  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /** Send a notification to all configured platforms. */
  async notify(text: string): Promise<void> {
    const promises: Promise<boolean>[] = [];
    if (this.config.slack) {
      promises.push(sendSlack(this.config.slack.webhookUrl, text));
    }
    if (this.config.email) {
      promises.push(sendEmail(this.config.email, text));
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
            ? "✅"
            : toStatus === "failed"
              ? "\u{1F534}"
              : toStatus === "stopped"
                ? "⏹"
                : "⚪";

    await this.notify(`${emoji} *${name}*: ${fromStatus} → ${toStatus}`);
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

  /** Start the bridge. No inbound listeners today -- kept for API symmetry. */
  start(): void {
    this.running = true;
  }

  /** Stop the bridge. */
  stop(): void {
    this.running = false;
  }

  /** Test hook -- is the bridge currently running? */
  isRunning(): boolean {
    return this.running;
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
  const bridge = new Bridge(config);
  bridge.start();
  return bridge;
}
