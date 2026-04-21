/**
 * GitHub webhook signature verification + payload normalization.
 *
 * GitHub signs webhook bodies with HMAC-SHA256 using the configured webhook
 * secret. The header is `X-Hub-Signature-256: sha256=<hex>`.
 *
 * We support the `issues`, `issue_comment`, and label-mutation flavours of
 * `issues` (actions: opened / edited / closed / reopened / assigned /
 * unassigned / labeled / unlabeled).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { TicketContext } from "../../types.js";
import type { NormalizedTicketEvent } from "../../types.js";
import { normalizeIssue, normalizeUser, type GhIssue, type GhUser } from "./normalize.js";

export function verifySignature(headers: Record<string, string>, body: string, ctx: TicketContext): boolean {
  const secret = ctx.credentials.webhookSecret;
  if (!secret) return false;
  const header = lowerGet(headers, "x-hub-signature-256") ?? "";
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

interface GhIssuesEvent {
  action: string;
  issue: GhIssue;
  comment?: { id: number; body: string; user: GhUser; created_at: string; updated_at: string };
  sender?: GhUser;
  changes?: Record<string, { from?: unknown }>;
  label?: { name: string };
  assignee?: GhUser;
}

export function normalizeWebhook(
  payload: unknown,
  headers: Record<string, string>,
  ctx: TicketContext,
): NormalizedTicketEvent | null {
  const event = lowerGet(headers, "x-github-event");
  if (!event) return null;
  const body = payload as GhIssuesEvent | null;
  if (!body || !body.issue) return null;
  const actor = normalizeUser(body.sender ?? body.issue.user);
  const ticket = normalizeIssue(body.issue, ctx.tenantId);
  const at = body.issue.updated_at ?? new Date().toISOString();

  if (event === "issue_comment") {
    return {
      kind: "commented",
      ticket,
      actor,
      at,
      tenantId: ctx.tenantId,
    };
  }
  if (event !== "issues") return null;
  const action = body.action;
  switch (action) {
    case "opened":
      return { kind: "created", ticket, actor, at, tenantId: ctx.tenantId };
    case "closed":
    case "reopened":
      return {
        kind: "transitioned",
        ticket,
        actor,
        at,
        tenantId: ctx.tenantId,
        changes: { state: { old: action === "closed" ? "open" : "closed", new: ticket.status.key } },
      };
    case "assigned":
    case "unassigned":
      return {
        kind: "assigned",
        ticket,
        actor,
        at,
        tenantId: ctx.tenantId,
        changes: body.assignee ? { assignee: { old: null, new: body.assignee.login } } : {},
      };
    case "edited":
      return {
        kind: "updated",
        ticket,
        actor,
        at,
        tenantId: ctx.tenantId,
        changes: body.changes ? extractChanges(body.changes) : {},
      };
    case "labeled":
    case "unlabeled":
      return {
        kind: "updated",
        ticket,
        actor,
        at,
        tenantId: ctx.tenantId,
        changes: body.label
          ? {
              labels: {
                old: action === "labeled" ? null : body.label.name,
                new: action === "labeled" ? body.label.name : null,
              },
            }
          : {},
      };
    case "deleted":
      return { kind: "deleted", ticket, actor, at, tenantId: ctx.tenantId };
    default:
      return { kind: "updated", ticket, actor, at, tenantId: ctx.tenantId };
  }
}

function extractChanges(changes: Record<string, { from?: unknown }>): Record<string, { old: unknown; new: unknown }> {
  const out: Record<string, { old: unknown; new: unknown }> = {};
  for (const [k, v] of Object.entries(changes)) {
    out[k] = { old: v?.from ?? null, new: null };
  }
  return out;
}

function lowerGet(h: Record<string, string>, key: string): string | undefined {
  if (h[key]) return h[key];
  const lk = key.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lk) return h[k];
  return undefined;
}
