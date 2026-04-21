/**
 * Bitbucket webhook verification + normalization.
 *
 * BB Cloud signs bodies with HMAC-SHA256 keyed on the per-hook secret. The
 * header is `X-Hub-Signature` with value `sha256=<hex>` (yes, same name as
 * GitHub's older header -- the hex digest format matches).
 *
 * Event kinds: `issue:created`, `issue:updated`, `issue:comment_created`.
 * The event name arrives in the `X-Event-Key` header.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedTicketEvent, TicketContext } from "../../types.js";
import { normalizeIssue, normalizeUser, type BbIssue, type BbUser } from "./normalize.js";

export function verifySignature(headers: Record<string, string>, body: string, ctx: TicketContext): boolean {
  const secret = ctx.credentials.webhookSecret;
  if (!secret) return false;
  const header = lowerGet(headers, "x-hub-signature") ?? "";
  if (!header.startsWith("sha256=")) return false;
  const expected = header.slice("sha256=".length);
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  if (hmac.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

interface BbHookBody {
  actor?: BbUser;
  issue?: BbIssue;
  changes?: Record<string, { old: unknown; new: unknown }>;
  comment?: { id: number; content?: { raw: string } };
  repository?: { full_name: string };
}

export function normalizeWebhook(
  payload: unknown,
  headers: Record<string, string>,
  ctx: TicketContext,
): NormalizedTicketEvent | null {
  const event = lowerGet(headers, "x-event-key") ?? "";
  if (!event.startsWith("issue:")) return null;
  const body = payload as BbHookBody | null;
  if (!body?.issue) return null;
  // Patch repository.full_name onto the issue for ref computation.
  if (body.repository?.full_name && !body.issue.repository) {
    body.issue.repository = { full_name: body.repository.full_name };
  }
  const ticket = normalizeIssue(body.issue, ctx.tenantId);
  const actor = normalizeUser(body.actor);
  const at = body.issue.updated_on ?? new Date().toISOString();

  if (event === "issue:created") return { kind: "created", ticket, actor, at, tenantId: ctx.tenantId };
  if (event === "issue:comment_created") {
    return { kind: "commented", ticket, actor, at, tenantId: ctx.tenantId };
  }
  if (event === "issue:updated") {
    const changes = body.changes ?? {};
    if ("state" in changes || "status" in changes) {
      return { kind: "transitioned", ticket, actor, at, tenantId: ctx.tenantId, changes };
    }
    if ("assignee" in changes) {
      return { kind: "assigned", ticket, actor, at, tenantId: ctx.tenantId, changes };
    }
    return { kind: "updated", ticket, actor, at, tenantId: ctx.tenantId, changes };
  }
  return null;
}

function lowerGet(h: Record<string, string>, key: string): string | undefined {
  if (h[key]) return h[key];
  const lk = key.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lk) return h[k];
  return undefined;
}
