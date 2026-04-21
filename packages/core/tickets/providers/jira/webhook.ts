/**
 * Jira webhook signature verification + payload normalisation.
 *
 * Atlassian Cloud Connect apps receive webhooks signed as a JWT in the
 * `Authorization: JWT <token>` header. The JWT is HS256-signed with the Connect
 * shared secret; the `iss` claim is the Connect `clientKey`, `qsh` is the
 * query-string hash of the inbound request (we do not validate qsh here -- it
 * requires the original method + path + query to re-hash, and the caller owns
 * that context).
 *
 * Jira DC (Server) does not sign natively; outbound webhooks are typically
 * plumbed through a proxy that adds `X-Hub-Signature: sha256=<hex>` HMAC over
 * the body with a shared secret. The DC path mirrors the existing pattern in
 * `packages/core/triggers/sources/jira.ts`.
 *
 * The `normalizeWebhook` half recognises the six Jira event kinds that matter
 * for ticket lifecycle: created, updated, deleted, comment_created,
 * comment_updated, comment_deleted -- and maps them to `NormalizedTicketEvent`
 * kinds. Comment events carry a `comment` payload but also an `issue` snapshot,
 * which we normalise so consumers always have a full ticket snapshot.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { NormalizedTicketEvent, NormalizedUser, TicketContext } from "../../types.js";
import { normalizeIssue, normalizeUser, unknownUser, type JiraIssue, type JiraUser } from "./normalize.js";

// Signature verification

export type WebhookMode = "cloud" | "dc";

export interface VerifySignatureOptions {
  mode: WebhookMode;
  /** Cloud Connect shared secret / DC HMAC secret. Taken from credentials. */
  secret: string;
  /** Cloud Connect clientKey -- the JWT iss must match. */
  expectedClientKey?: string;
}

export function getWebhookMode(ctx: TicketContext): WebhookMode {
  const mode = (ctx.credentials.extra?.webhookMode as string | undefined) ?? "cloud";
  return mode === "dc" ? "dc" : "cloud";
}

export function getWebhookSecret(ctx: TicketContext): string | null {
  return ctx.credentials.webhookSecret ?? null;
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) {
    try {
      timingSafeEqual(ab, Buffer.alloc(ab.length, 0));
    } catch {
      // keep timing uniform
    }
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function base64UrlDecode(input: string): Buffer {
  const pad = 4 - (input.length % 4);
  const padded = input + (pad < 4 ? "=".repeat(pad) : "");
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface JwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
}

interface JwtClaims {
  iss?: string;
  iat?: number;
  exp?: number;
  qsh?: string;
  sub?: string;
}

export interface JwtParts {
  header: JwtHeader;
  claims: JwtClaims;
  signingInput: string;
  signature: Buffer;
}

/** Decode (but do not verify) a JWT into its three parts. Exposed for tests. */
export function decodeJwt(token: string): JwtParts | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(base64UrlDecode(parts[0]).toString("utf-8")) as JwtHeader;
    const claims = JSON.parse(base64UrlDecode(parts[1]).toString("utf-8")) as JwtClaims;
    const signature = base64UrlDecode(parts[2]);
    return { header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature };
  } catch {
    return null;
  }
}

/**
 * Verify a Jira Cloud Connect JWT. Only HS256 is supported (Connect uses it
 * by default). RS256-signed Connect 2.0 tokens would need a JWK fetch --
 * noted as a follow-up. Returns true when:
 *   - alg is HS256
 *   - signature verifies against secret
 *   - iss matches expectedClientKey (when supplied)
 *   - exp (if present) is in the future
 */
export function verifyConnectJwt(token: string, opts: VerifySignatureOptions): boolean {
  const parts = decodeJwt(token);
  if (!parts) return false;
  if ((parts.header.alg ?? "").toUpperCase() !== "HS256") return false;
  const computed = createHmac("sha256", opts.secret).update(parts.signingInput).digest();
  if (computed.length !== parts.signature.length) return false;
  if (!timingSafeEqual(computed, parts.signature)) return false;
  if (opts.expectedClientKey && parts.claims.iss !== opts.expectedClientKey) return false;
  if (typeof parts.claims.exp === "number" && parts.claims.exp * 1000 < Date.now()) return false;
  return true;
}

/** Verify a Jira DC HMAC signature (X-Hub-Signature: sha256=<hex>). */
export function verifyDcHmac(body: string, headerVal: string | null, secret: string): boolean {
  if (!headerVal) return false;
  const trimmed = headerVal.startsWith("sha256=") ? headerVal.slice(7) : headerVal;
  const computed = createHmac("sha256", secret).update(body).digest("hex");
  return constantTimeEqual(trimmed, computed);
}

export function verifyWebhookSignature(headers: Record<string, string>, body: string, ctx: TicketContext): boolean {
  const secret = getWebhookSecret(ctx);
  if (!secret) return false;
  const mode = getWebhookMode(ctx);

  if (mode === "cloud") {
    const auth = headerValue(headers, "authorization") ?? "";
    const m = /^JWT\s+(.+)$/.exec(auth);
    if (!m) return false;
    const expectedClientKey = ctx.credentials.extra?.clientKey as string | undefined;
    return verifyConnectJwt(m[1], { mode, secret, expectedClientKey });
  }

  return verifyDcHmac(body, headerValue(headers, "x-hub-signature"), secret);
}

// Webhook payload normalisation

export interface JiraWebhookPayload {
  webhookEvent?: string;
  issue_event_type_name?: string;
  timestamp?: number;
  user?: JiraUser;
  issue?: JiraIssue;
  comment?: {
    id: string;
    author?: JiraUser;
    body?: unknown;
    created: string;
    updated?: string;
  };
  changelog?: {
    id: string;
    items?: {
      field: string;
      fromString?: string | null;
      toString?: string | null;
    }[];
  };
}

const EVENT_MAP: Record<string, NormalizedTicketEvent["kind"]> = {
  "jira:issue_created": "created",
  "jira:issue_updated": "updated",
  "jira:issue_deleted": "deleted",
  comment_created: "commented",
  comment_updated: "commented",
  comment_deleted: "commented",
  "jira:worklog_updated": "updated",
};

export interface NormalizeWebhookOptions {
  tenantId: string;
  webBaseUrl?: string;
}

function actorFrom(payload: JiraWebhookPayload): NormalizedUser {
  return normalizeUser(payload.user ?? payload.issue?.fields?.reporter ?? null) ?? unknownUser();
}

export function normalizeWebhookPayload(
  payload: JiraWebhookPayload,
  opts: NormalizeWebhookOptions,
): NormalizedTicketEvent | null {
  const eventName = payload.webhookEvent ?? "";
  const kind = EVENT_MAP[eventName];
  if (!kind) return null;
  if (!payload.issue) return null;

  // Detect transitioned / assigned as specialisations of updated.
  let resolvedKind: NormalizedTicketEvent["kind"] = kind;
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  if (payload.changelog?.items) {
    for (const item of payload.changelog.items) {
      changes[item.field] = {
        old: item.fromString ?? null,
        new: item.toString ?? null,
      };
      if (item.field.toLowerCase() === "status" && kind === "updated") {
        resolvedKind = "transitioned";
      }
      if (item.field.toLowerCase() === "assignee" && kind === "updated") {
        resolvedKind = "assigned";
      }
    }
  }

  const ticket = normalizeIssue(payload.issue, { tenantId: opts.tenantId, webBaseUrl: opts.webBaseUrl });

  return {
    kind: resolvedKind,
    ticket,
    changes: Object.keys(changes).length ? changes : undefined,
    actor: actorFrom(payload),
    at: payload.timestamp ? new Date(payload.timestamp).toISOString() : new Date().toISOString(),
    tenantId: opts.tenantId,
  };
}
