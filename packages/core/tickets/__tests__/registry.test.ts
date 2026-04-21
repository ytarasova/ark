import { describe, it, expect, beforeEach } from "bun:test";
import {
  InMemoryTicketProviderBindingRepository,
  TicketProviderRegistry,
  type TicketProviderBinding,
} from "../registry.js";
import type { TicketProvider } from "../types.js";

function fakeProvider(kind: TicketProvider["kind"]): TicketProvider {
  const stub = async () => {
    throw new Error("not implemented");
  };
  return {
    kind,
    getIssue: stub as TicketProvider["getIssue"],
    searchIssues: stub as TicketProvider["searchIssues"],
    listComments: stub as TicketProvider["listComments"],
    listActivity: stub as TicketProvider["listActivity"],
    postComment: stub as TicketProvider["postComment"],
    updateIssue: stub as TicketProvider["updateIssue"],
    transitionStatus: stub as TicketProvider["transitionStatus"],
    addLabel: stub as TicketProvider["addLabel"],
    removeLabel: stub as TicketProvider["removeLabel"],
    normalizeWebhook: () => null,
    verifySignature: () => false,
    testConnection: async () => ({ ok: true }),
  };
}

function makeBinding(tenantId: string, provider: TicketProvider["kind"]): TicketProviderBinding {
  const now = new Date().toISOString();
  return {
    tenantId,
    provider,
    credentials: { token: `tok-${tenantId}-${provider}` },
    writeEnabled: false,
    createdAt: now,
    updatedAt: now,
  };
}

describe("TicketProviderRegistry", () => {
  let reg: TicketProviderRegistry;
  beforeEach(() => {
    reg = new TicketProviderRegistry(new InMemoryTicketProviderBindingRepository());
  });

  it("round-trips register + bind + get + unbind", async () => {
    reg.register("jira", () => fakeProvider("jira"));
    await reg.bind(makeBinding("t1", "jira"));

    const resolved = await reg.get("t1", "jira");
    expect(resolved).not.toBeNull();
    expect(resolved!.provider.kind).toBe("jira");
    expect(resolved!.ctx.tenantId).toBe("t1");
    expect(resolved!.ctx.credentials.token).toBe("tok-t1-jira");
    expect(resolved!.ctx.writeEnabled).toBe(false);

    await reg.unbind("t1", "jira");
    expect(await reg.get("t1", "jira")).toBeNull();
  });

  it("supports multiple providers for the same tenant", async () => {
    reg.register("jira", () => fakeProvider("jira"));
    reg.register("github", () => fakeProvider("github"));
    await reg.bind(makeBinding("t1", "jira"));
    await reg.bind(makeBinding("t1", "github"));

    const bindings = await reg.list("t1");
    expect(bindings.map((b) => b.provider).sort()).toEqual(["github", "jira"]);

    const jira = await reg.get("t1", "jira");
    const gh = await reg.get("t1", "github");
    expect(jira!.provider.kind).toBe("jira");
    expect(gh!.provider.kind).toBe("github");
  });

  it("isolates bindings between tenants", async () => {
    reg.register("jira", () => fakeProvider("jira"));
    await reg.bind(makeBinding("t1", "jira"));
    await reg.bind(makeBinding("t2", "jira"));

    const t1 = await reg.get("t1", "jira");
    const t2 = await reg.get("t2", "jira");
    expect(t1!.ctx.credentials.token).toBe("tok-t1-jira");
    expect(t2!.ctx.credentials.token).toBe("tok-t2-jira");

    expect((await reg.list("t1")).every((b) => b.tenantId === "t1")).toBe(true);
    expect((await reg.list("t2")).every((b) => b.tenantId === "t2")).toBe(true);
  });

  it("refuses to bind an unregistered provider kind", async () => {
    await expect(reg.bind(makeBinding("t1", "linear"))).rejects.toThrow(/unknown provider kind/);
  });

  it("returns null when no factory or no binding exists", async () => {
    // factory missing
    expect(await reg.get("t1", "jira")).toBeNull();
    // factory present, binding missing
    reg.register("jira", () => fakeProvider("jira"));
    expect(await reg.get("t1", "jira")).toBeNull();
  });

  it("freshly factories the provider on each get() so state does not leak", async () => {
    let count = 0;
    reg.register("jira", () => {
      count += 1;
      return fakeProvider("jira");
    });
    await reg.bind(makeBinding("t1", "jira"));
    await reg.get("t1", "jira");
    await reg.get("t1", "jira");
    expect(count).toBe(2);
  });
});
