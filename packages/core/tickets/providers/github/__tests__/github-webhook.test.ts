import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TicketContext } from "../../../types.js";
import { normalizeWebhook, verifySignature } from "../webhook.js";

const HERE = new URL(".", import.meta.url).pathname;
function loadRaw(name: string): string {
  return readFileSync(join(HERE, "..", "fixtures", name), "utf8");
}

function ctx(writeEnabled = false, webhookSecret = "shh"): TicketContext {
  return {
    tenantId: "tenant-1",
    credentials: { token: "tok", webhookSecret },
    writeEnabled,
  };
}

describe("github webhook signature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"hello":"world"}';
    const sig = createHmac("sha256", "shh").update(body).digest("hex");
    expect(verifySignature({ "x-hub-signature-256": `sha256=${sig}` }, body, ctx())).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifySignature({ "x-hub-signature-256": "sha256=deadbeef" }, "{}", ctx())).toBe(false);
  });

  it("rejects when secret is missing", () => {
    const c = ctx(false, "");
    c.credentials.webhookSecret = undefined;
    expect(verifySignature({ "x-hub-signature-256": "sha256=abc" }, "{}", c)).toBe(false);
  });

  it("rejects header without sha256= prefix", () => {
    expect(verifySignature({ "x-hub-signature-256": "abc" }, "{}", ctx())).toBe(false);
  });

  it("is case-insensitive for header names", () => {
    const body = "{}";
    const sig = createHmac("sha256", "shh").update(body).digest("hex");
    expect(verifySignature({ "X-Hub-Signature-256": `sha256=${sig}` }, body, ctx())).toBe(true);
  });
});

describe("github webhook normalize", () => {
  it("normalizes issues.opened -> created", () => {
    const payload = JSON.parse(loadRaw("webhook-opened.json"));
    const event = normalizeWebhook(payload, { "x-github-event": "issues" }, ctx());
    expect(event?.kind).toBe("created");
    expect(event?.ticket.key).toBe("#42");
    expect(event?.actor.name).toBe("alice");
    expect(event?.tenantId).toBe("tenant-1");
  });

  it("normalizes issue_comment.created -> commented", () => {
    const payload = JSON.parse(loadRaw("webhook-comment.json"));
    const event = normalizeWebhook(payload, { "x-github-event": "issue_comment" }, ctx());
    expect(event?.kind).toBe("commented");
    expect(event?.ticket.id).toBe("acme/widgets#42");
  });

  it("normalizes issues.closed -> transitioned", () => {
    const payload = JSON.parse(loadRaw("webhook-closed.json"));
    const event = normalizeWebhook(payload, { "x-github-event": "issues" }, ctx());
    expect(event?.kind).toBe("transitioned");
    expect(event?.ticket.status.category).toBe("done");
    expect(event?.changes).toBeDefined();
  });

  it("ignores unknown event header", () => {
    const payload = JSON.parse(loadRaw("webhook-opened.json"));
    expect(normalizeWebhook(payload, {}, ctx())).toBeNull();
    expect(normalizeWebhook(payload, { "x-github-event": "push" }, ctx())).toBeNull();
  });

  it("returns null on malformed payloads", () => {
    expect(normalizeWebhook(null, { "x-github-event": "issues" }, ctx())).toBeNull();
    expect(normalizeWebhook({}, { "x-github-event": "issues" }, ctx())).toBeNull();
  });
});
