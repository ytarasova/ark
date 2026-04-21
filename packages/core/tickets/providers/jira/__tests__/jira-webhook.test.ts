import { describe, it, expect } from "bun:test";
import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { JiraProvider } from "../index.js";
import { decodeJwt, normalizeWebhookPayload, verifyConnectJwt, verifyDcHmac } from "../webhook.js";
import type { TicketContext } from "../../../types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as T;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(header: object, claims: object, secret: string): string {
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const c = b64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${h}.${c}`;
  const sig = b64url(createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

describe("Jira Cloud JWT verification", () => {
  const secret = "shared-connect-secret";

  it("verifies a valid HS256 Connect JWT with matching clientKey", () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = makeJwt({ alg: "HS256", typ: "JWT" }, { iss: "client-key-acme", iat, exp: iat + 60 }, secret);
    expect(verifyConnectJwt(token, { mode: "cloud", secret, expectedClientKey: "client-key-acme" })).toBe(true);
  });

  it("rejects tokens whose iss does not match expectedClientKey", () => {
    const token = makeJwt({ alg: "HS256", typ: "JWT" }, { iss: "other-tenant" }, secret);
    expect(verifyConnectJwt(token, { mode: "cloud", secret, expectedClientKey: "client-key-acme" })).toBe(false);
  });

  it("rejects tokens signed with the wrong secret", () => {
    const token = makeJwt({ alg: "HS256", typ: "JWT" }, { iss: "client-key-acme" }, "bogus");
    expect(verifyConnectJwt(token, { mode: "cloud", secret })).toBe(false);
  });

  it("rejects tokens with non-HS256 alg (RS256 not yet supported)", () => {
    const token = makeJwt({ alg: "RS256", typ: "JWT" }, { iss: "client-key-acme" }, secret);
    expect(verifyConnectJwt(token, { mode: "cloud", secret })).toBe(false);
  });

  it("rejects expired tokens", () => {
    const token = makeJwt(
      { alg: "HS256", typ: "JWT" },
      { iss: "client-key-acme", exp: Math.floor(Date.now() / 1000) - 5 },
      secret,
    );
    expect(verifyConnectJwt(token, { mode: "cloud", secret })).toBe(false);
  });

  it("decodeJwt returns null on malformed input", () => {
    expect(decodeJwt("not.a.jwt.too-many-parts.here")).toBeNull();
    expect(decodeJwt("only-one-part")).toBeNull();
  });
});

describe("Jira DC HMAC verification", () => {
  const secret = "dc-hmac-secret";
  it("verifies X-Hub-Signature: sha256=<hex>", () => {
    const body = '{"webhookEvent":"jira:issue_created"}';
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyDcHmac(body, sig, secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = "sha256=" + createHmac("sha256", secret).update("original").digest("hex");
    expect(verifyDcHmac("tampered", sig, secret)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyDcHmac("body", null, secret)).toBe(false);
  });
});

describe("JiraProvider.verifySignature dispatch", () => {
  const provider = new JiraProvider();
  const makeCtx = (overrides: Partial<TicketContext["credentials"]>): TicketContext => ({
    tenantId: "t1",
    credentials: { baseUrl: "https://acme.atlassian.net", webhookSecret: "secret", ...overrides },
    writeEnabled: false,
  });

  it("dispatches to DC mode when credentials.extra.webhookMode is 'dc'", () => {
    const body = '{"hello":"world"}';
    const sig = "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
    const ctx = makeCtx({ extra: { webhookMode: "dc" } });
    expect(provider.verifySignature({ "x-hub-signature": sig }, body, ctx)).toBe(true);
  });

  it("dispatches to cloud mode by default and verifies JWT", () => {
    const iat = Math.floor(Date.now() / 1000);
    const jwt = makeJwt({ alg: "HS256", typ: "JWT" }, { iss: "client-key-acme", iat, exp: iat + 60 }, "secret");
    const ctx = makeCtx({ extra: { clientKey: "client-key-acme" } });
    expect(provider.verifySignature({ authorization: `JWT ${jwt}` }, "", ctx)).toBe(true);
  });

  it("returns false when webhookSecret is missing", () => {
    const ctx: TicketContext = {
      tenantId: "t1",
      credentials: { baseUrl: "https://acme.atlassian.net" },
      writeEnabled: false,
    };
    expect(provider.verifySignature({}, "", ctx)).toBe(false);
  });
});

describe("normalizeWebhookPayload", () => {
  it("maps jira:issue_created -> created", () => {
    const payload = load<object>("webhook-issue-created.json");
    const event = normalizeWebhookPayload(payload, { tenantId: "t1" });
    expect(event?.kind).toBe("created");
    expect(event?.ticket.key).toBe("PROJ-9");
    expect(event?.actor.name).toBe("Yana Tarasova");
  });

  it("maps jira:issue_updated with status change -> transitioned", () => {
    const payload = load<object>("webhook-issue-updated.json");
    const event = normalizeWebhookPayload(payload, { tenantId: "t1" });
    expect(event?.kind).toBe("transitioned");
    expect(event?.changes?.status).toEqual({ old: "To Do", new: "In Progress" });
  });

  it("maps comment_created -> commented", () => {
    const payload = load<object>("webhook-comment-created.json");
    const event = normalizeWebhookPayload(payload, { tenantId: "t1" });
    expect(event?.kind).toBe("commented");
  });

  it("returns null for unknown webhookEvent", () => {
    expect(normalizeWebhookPayload({ webhookEvent: "something_weird" }, { tenantId: "t1" })).toBeNull();
  });

  it("returns null when there is no issue snapshot", () => {
    expect(normalizeWebhookPayload({ webhookEvent: "jira:issue_created" }, { tenantId: "t1" })).toBeNull();
  });

  it("maps jira:issue_deleted -> deleted", () => {
    const payload = load<{ issue?: unknown }>("webhook-issue-created.json");
    const mutated = { ...payload, webhookEvent: "jira:issue_deleted" };
    const event = normalizeWebhookPayload(mutated, { tenantId: "t1" });
    expect(event?.kind).toBe("deleted");
  });

  it("detects assigned as a specialisation of updated", () => {
    const payload = load<{ changelog?: unknown }>("webhook-issue-updated.json");
    const mutated = {
      ...payload,
      changelog: { id: "1", items: [{ field: "assignee", fromString: null, toString: "Aisha Rao" }] },
    };
    const event = normalizeWebhookPayload(mutated, { tenantId: "t1" });
    expect(event?.kind).toBe("assigned");
  });
});
