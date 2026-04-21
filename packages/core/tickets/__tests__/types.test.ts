import { describe, it, expect } from "bun:test";
import type { NormalizedTicket, NormalizedUser, NormalizedStatus } from "../types.js";
import { TicketNotFoundError, TicketWriteDisabledError } from "../types.js";
import { emptyMdx } from "../richtext/mdx.js";

describe("ticket types sanity", () => {
  it("constructs a NormalizedTicket with every required field populated", () => {
    const reporter: NormalizedUser = {
      id: "u1",
      email: "a@example.com",
      name: "A",
      avatarUrl: null,
      provider: "jira",
      raw: {},
    };
    const status: NormalizedStatus = { key: "open", label: "Open", category: "todo" };
    const ticket: NormalizedTicket = {
      provider: "jira",
      id: "10001",
      key: "PROJ-1",
      url: "https://example.atlassian.net/browse/PROJ-1",
      title: "Hello",
      body: emptyMdx(),
      status,
      type: "task",
      assignee: null,
      reporter,
      priority: null,
      labels: [],
      parentId: null,
      children: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      tenantId: "t1",
      raw: {},
    };
    expect(ticket.provider).toBe("jira");
    expect(ticket.body.type).toBe("root");
  });

  it("TicketWriteDisabledError and TicketNotFoundError carry context", () => {
    const a = new TicketWriteDisabledError("jira", "postComment");
    expect(a.provider).toBe("jira");
    expect(a.op).toBe("postComment");
    expect(a.message).toContain("jira");

    const b = new TicketNotFoundError("github", "PROJ-1");
    expect(b.provider).toBe("github");
    expect(b.id).toBe("PROJ-1");
  });
});
