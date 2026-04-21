/**
 * Linear webhook signature verification + normalization.
 *
 * Signature: `linear-signature` header is HMAC-SHA256 hex of the raw body
 * using the webhook signing secret.
 *
 * Event kinds: `Issue`, `Comment`, `IssueLabel`, `Reaction`, `Project`, ...
 * We cover `Issue` (create/update/remove) and `Comment` (create/update/remove)
 * -- the rest fall through to `null`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedTicketEvent, TicketContext } from "../../types.js";
import { normalizeIssue, normalizeUser, type LinearIssue, type LinearUser } from "./normalize.js";

export function verifySignature(headers: Record<string, string>, body: string, ctx: TicketContext): boolean {
  const secret = ctx.credentials.webhookSecret;
  if (!secret) return false;
  const sig = lowerGet(headers, "linear-signature") ?? "";
  if (!sig) return false;
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  if (hmac.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

interface LinearWebhookBody {
  action: "create" | "update" | "remove";
  type: string; // "Issue" | "Comment" | ...
  data: unknown;
  /** Present on update events; a map of fieldName -> oldValue. */
  updatedFrom?: Record<string, unknown>;
  actor?: LinearUser;
  /** Present on Comment events; the parent issue (minimal). */
  createdAt?: string;
}

export function normalizeWebhook(
  payload: unknown,
  _headers: Record<string, string>,
  ctx: TicketContext,
): NormalizedTicketEvent | null {
  const body = payload as LinearWebhookBody | null;
  if (!body || !body.type || !body.action) return null;
  const actor = normalizeUser(body.actor ?? null);
  const at = body.createdAt ?? new Date().toISOString();

  if (body.type === "Issue") {
    const issue = body.data as LinearIssue | null;
    if (!issue) return null;
    const ticket = normalizeIssue(issue, ctx.tenantId);
    if (body.action === "create") return { kind: "created", ticket, actor, at, tenantId: ctx.tenantId };
    if (body.action === "remove") return { kind: "deleted", ticket, actor, at, tenantId: ctx.tenantId };
    // update: classify into transitioned / assigned / updated based on diff.
    const changes = extractChanges(body.updatedFrom ?? {}, issue);
    if ("state" in (body.updatedFrom ?? {}) || "stateId" in (body.updatedFrom ?? {})) {
      return { kind: "transitioned", ticket, actor, at, tenantId: ctx.tenantId, changes };
    }
    if ("assigneeId" in (body.updatedFrom ?? {}) || "assignee" in (body.updatedFrom ?? {})) {
      return { kind: "assigned", ticket, actor, at, tenantId: ctx.tenantId, changes };
    }
    return { kind: "updated", ticket, actor, at, tenantId: ctx.tenantId, changes };
  }

  if (body.type === "Comment") {
    // Linear's Comment webhook payload nests the issue under `data.issue`.
    const c = body.data as { issue?: LinearIssue } | null;
    if (!c?.issue) return null;
    const ticket = normalizeIssue(c.issue, ctx.tenantId);
    return { kind: "commented", ticket, actor, at, tenantId: ctx.tenantId };
  }

  return null;
}

function extractChanges(
  updatedFrom: Record<string, unknown>,
  after: LinearIssue,
): Record<string, { old: unknown; new: unknown }> {
  const out: Record<string, { old: unknown; new: unknown }> = {};
  for (const [k, v] of Object.entries(updatedFrom)) {
    out[k] = { old: v, new: (after as unknown as Record<string, unknown>)[k] ?? null };
  }
  return out;
}

function lowerGet(h: Record<string, string>, key: string): string | undefined {
  if (h[key]) return h[key];
  const lk = key.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lk) return h[k];
  return undefined;
}
