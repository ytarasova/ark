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
    credentials: { bearer: "t", webhookSecret },
    writeEnabled: false,
  };
}

describe("bitbucket webhook signature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"hi":1}';
    const sig = createHmac("sha256", "shh").update(body).digest("hex");
    expect(verifySignature({ "x-hub-signature": `sha256=${sig}` }, body, ctx())).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = '{"hi":1}';
    const sig = createHmac("sha256", "shh").update(body).digest("hex");
    expect(verifySignature({ "x-hub-signature": `sha256=${sig}` }, "{}", ctx())).toBe(false);
  });

  it("rejects header without sha256= prefix", () => {
    expect(verifySignature({ "x-hub-signature": "abc" }, "{}", ctx())).toBe(false);
  });

  it("rejects when webhookSecret missing", () => {
    const c = ctx();
    c.credentials.webhookSecret = undefined;
    expect(verifySignature({ "x-hub-signature": "sha256=abc" }, "{}", c)).toBe(false);
  });
});

describe("bitbucket webhook normalize", () => {
  it("issue:created -> created", () => {
    const e = normalizeWebhook(load("webhook-created.json"), { "x-event-key": "issue:created" }, ctx());
    expect(e?.kind).toBe("created");
    expect(e?.ticket.id).toBe("acme/widgets#7");
    expect(e?.ticket.status.category).toBe("todo");
  });

  it("issue:updated with state change -> transitioned", () => {
    const e = normalizeWebhook(load("webhook-updated.json"), { "x-event-key": "issue:updated" }, ctx());
    expect(e?.kind).toBe("transitioned");
    expect(e?.ticket.status.category).toBe("done"); // resolved
    expect(e?.changes?.state).toEqual({ old: "new", new: "resolved" });
  });

  it("issue:comment_created -> commented", () => {
    const e = normalizeWebhook(load("webhook-comment.json"), { "x-event-key": "issue:comment_created" }, ctx());
    expect(e?.kind).toBe("commented");
    expect(e?.ticket.id).toBe("acme/widgets#7");
  });

  it("returns null for unknown event keys", () => {
    expect(normalizeWebhook(load("webhook-created.json"), { "x-event-key": "pullrequest:created" }, ctx())).toBeNull();
    expect(normalizeWebhook(load("webhook-created.json"), {}, ctx())).toBeNull();
  });

  it("returns null for payload without issue", () => {
    expect(normalizeWebhook({}, { "x-event-key": "issue:created" }, ctx())).toBeNull();
  });
});
