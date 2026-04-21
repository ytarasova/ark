import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TicketContext } from "../../../types.js";
import { normalizeWebhook, verifySignature } from "../webhook.js";

const HERE = new URL(".", import.meta.url).pathname;
function load(name: string): unknown {
  return JSON.parse(readFileSync(join(HERE, "..", "fixtures", name), "utf8"));
}

function ctx(webhookSecret = "shh"): TicketContext {
  return {
    tenantId: "t1",
    credentials: { token: "k", webhookSecret },
    writeEnabled: false,
  };
}

describe("linear webhook signature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"hi":1}';
    const sig = createHmac("sha256", "shh").update(body).digest("hex");
    expect(verifySignature({ "linear-signature": sig }, body, ctx())).toBe(true);
  });

  it("rejects wrong signature", () => {
    expect(verifySignature({ "linear-signature": "deadbeef" }, "{}", ctx())).toBe(false);
  });

  it("rejects missing secret", () => {
    const c = ctx();
    c.credentials.webhookSecret = undefined;
    expect(verifySignature({ "linear-signature": "abc" }, "{}", c)).toBe(false);
  });

  it("is case-insensitive on the header name", () => {
    const body = "{}";
    const sig = createHmac("sha256", "shh").update(body).digest("hex");
    expect(verifySignature({ "Linear-Signature": sig }, body, ctx())).toBe(true);
  });
});

describe("linear webhook normalize", () => {
  it("Issue.create -> created", () => {
    const event = normalizeWebhook(load("webhook-issue-create.json"), {}, ctx());
    expect(event?.kind).toBe("created");
    expect(event?.ticket.key).toBe("ENG-123");
    expect(event?.ticket.status.category).toBe("todo");
  });

  it("Issue.update with state change -> transitioned", () => {
    const event = normalizeWebhook(load("webhook-issue-update.json"), {}, ctx());
    expect(event?.kind).toBe("transitioned");
    expect(event?.changes).toBeDefined();
  });

  it("Comment.create -> commented, ticket resolves from data.issue", () => {
    const event = normalizeWebhook(load("webhook-comment-create.json"), {}, ctx());
    expect(event?.kind).toBe("commented");
    expect(event?.ticket.id).toBe("ENG-123");
  });

  it("returns null for unsupported types", () => {
    expect(normalizeWebhook({ action: "create", type: "Project", data: {} }, {}, ctx())).toBeNull();
    expect(normalizeWebhook(null, {}, ctx())).toBeNull();
    expect(normalizeWebhook({}, {}, ctx())).toBeNull();
  });
});
