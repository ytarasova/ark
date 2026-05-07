/**
 * Handler tenant-scoping regression (round-3 DI P1-1).
 *
 * Before this migration the local-daemon WS handlers closed over the root
 * `app` at registration time, so `session/*`, `message/*`, and `history/*`
 * reads/writes bypassed the caller's ctx.tenantId entirely -- every call
 * landed in default-tenant repos.
 *
 * Now each handler resolves through `resolveTenantApp(app, ctx)` per
 * request. Direct repo operations on the scoped context (`scoped.sessions`,
 * `scoped.events`, `scoped.messages`, `scoped.todos`, `scoped.artifacts`,
 * `scoped.computes`) therefore honour the caller's tenant id.
 *
 * Scope note: service-tree singletons (`sessionLifecycle`, `sessionService`,
 * `sessionHooks`) are not yet re-registered as SCOPED on the child container
 * in this branch -- that is the separate round-2 P0-1 fix. Handlers that
 * delegate exclusively through those services still land in the default
 * tenant today (covered by the round-2 P0-1 follow-up). The assertions
 * below exercise the direct-repo paths only, which is what DI P1-1 closes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerSessionHandlers } from "../session.js";
import { registerMessagingHandlers } from "../messaging.js";
import { createRequest, type JsonRpcResponse } from "../../../protocol/types.js";
import type { TenantContext } from "../../../core/auth/context.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerSessionHandlers(router, app);
  registerMessagingHandlers(router, app);
});

function adminCtx(tenantId: string): TenantContext {
  return { tenantId, userId: "test-user", role: "admin", isAdmin: true };
}

function ok(res: unknown): Record<string, any> {
  return (res as JsonRpcResponse).result as Record<string, any>;
}

describe("handler tenant-scoping (round-3 DI P1-1)", () => {
  it("session/list returns only the caller's tenant sessions", async () => {
    // Seed two tenants with distinct sessions via the tenant-scoped repo.
    const acme = app.forTenant("acme-list");
    await acme.sessions.create({ summary: "acme list 1" });
    await acme.sessions.create({ summary: "acme list 2" });

    const other = app.forTenant("other-list");
    await other.sessions.create({ summary: "other list 1" });

    const resAcme = ok(await router.dispatch(createRequest(1, "session/list", {}), undefined, adminCtx("acme-list")));
    expect(resAcme.sessions.length).toBe(2);
    for (const s of resAcme.sessions) expect(s.tenant_id).toBe("acme-list");

    const resOther = ok(await router.dispatch(createRequest(1, "session/list", {}), undefined, adminCtx("other-list")));
    expect(resOther.sessions.length).toBe(1);
    expect(resOther.sessions[0].tenant_id).toBe("other-list");
  });

  it("session/read refuses cross-tenant lookups", async () => {
    const acme = app.forTenant("acme-read");
    const s = await acme.sessions.create({ summary: "acme-read session" });

    // Caller in a different tenant -- must NOT find the session.
    const res = (await router.dispatch(
      createRequest(1, "session/read", { sessionId: s.id }),
      undefined,
      adminCtx("other-read"),
    )) as JsonRpcResponse;
    expect("error" in res).toBe(true);
    expect((res as any).error.message).toContain("not found");

    // Same session under its owning tenant reads back cleanly.
    const resOwner = (await router.dispatch(
      createRequest(2, "session/read", { sessionId: s.id }),
      undefined,
      adminCtx("acme-read"),
    )) as JsonRpcResponse;
    expect("error" in resOwner).toBe(false);
    expect((resOwner as any).result.session.id).toBe(s.id);
  });

  it("session/update cannot mutate another tenant's session", async () => {
    const acme = app.forTenant("acme-update");
    const s = await acme.sessions.create({ summary: "original" });

    const res = (await router.dispatch(
      createRequest(1, "session/update", { sessionId: s.id, fields: { summary: "hijacked" } }),
      undefined,
      adminCtx("other-update"),
    )) as JsonRpcResponse;
    expect("error" in res).toBe(true);

    // Original summary is preserved on the owning tenant's row.
    const roundtrip = await acme.sessions.get(s.id);
    expect(roundtrip!.summary).toBe("original");
  });

  it("session/events is scoped to the caller's tenant", async () => {
    const acme = app.forTenant("acme-events");
    const s = await acme.sessions.create({ summary: "events test" });
    await acme.events.log(s.id, "test_event", { actor: "user", data: {} });

    // Owner sees the event.
    const ownerRes = ok(
      await router.dispatch(
        createRequest(1, "session/events", { sessionId: s.id }),
        undefined,
        adminCtx("acme-events"),
      ),
    );
    expect(ownerRes.events.length).toBe(1);
    expect(ownerRes.events[0].type).toBe("test_event");

    // Other tenant sees nothing (cross-tenant event lookup returns []).
    const otherRes = ok(
      await router.dispatch(
        createRequest(2, "session/events", { sessionId: s.id }),
        undefined,
        adminCtx("other-events"),
      ),
    );
    expect(otherRes.events.length).toBe(0);
  });

  it("session/messages is scoped to the caller's tenant", async () => {
    const acme = app.forTenant("acme-msgs");
    const s = await acme.sessions.create({ summary: "msg test" });
    await acme.messages.send(s.id, "user", "hello");

    const ownerRes = ok(
      await router.dispatch(
        createRequest(1, "session/messages", { sessionId: s.id }),
        undefined,
        adminCtx("acme-msgs"),
      ),
    );
    expect(ownerRes.messages.length).toBe(1);
    expect(ownerRes.messages[0].content).toBe("hello");

    const otherRes = ok(
      await router.dispatch(
        createRequest(2, "session/messages", { sessionId: s.id }),
        undefined,
        adminCtx("other-msgs"),
      ),
    );
    expect(otherRes.messages.length).toBe(0);
  });

  it("todo/list returns only the caller's tenant todos", async () => {
    const acme = app.forTenant("acme-todo");
    const s = await acme.sessions.create({ summary: "todo test" });
    await acme.todos.add(s.id, "fix it");

    const ownerRes = ok(
      await router.dispatch(createRequest(1, "todo/list", { sessionId: s.id }), undefined, adminCtx("acme-todo")),
    );
    expect(ownerRes.todos.length).toBe(1);

    const otherRes = ok(
      await router.dispatch(createRequest(2, "todo/list", { sessionId: s.id }), undefined, adminCtx("other-todo")),
    );
    expect(otherRes.todos.length).toBe(0);
  });

  it("message/markRead writes through the caller's tenant messages repo", async () => {
    const acme = app.forTenant("acme-mark");
    const s = await acme.sessions.create({ summary: "mark-read test" });
    await acme.messages.send(s.id, "agent", "hello");

    // Pre: acme has 1 unread; other tenant has 0.
    expect(await acme.messages.unreadCount(s.id)).toBe(1);

    // Call markRead from a DIFFERENT tenant -- must not clear acme's unread.
    await router.dispatch(createRequest(1, "message/markRead", { sessionId: s.id }), undefined, adminCtx("other-mark"));
    expect(await acme.messages.unreadCount(s.id)).toBe(1);

    // Call markRead from the OWNING tenant -- clears unread for acme only.
    await router.dispatch(createRequest(2, "message/markRead", { sessionId: s.id }), undefined, adminCtx("acme-mark"));
    expect(await acme.messages.unreadCount(s.id)).toBe(0);
  });

  it("session/artifacts/list is scoped to the caller's tenant", async () => {
    const acme = app.forTenant("acme-art");
    const s = await acme.sessions.create({ summary: "artifact test" });
    await acme.artifacts.add(s.id, "file_edit" as any, ["README.md"], {});

    const ownerRes = ok(
      await router.dispatch(
        createRequest(1, "session/artifacts/list", { sessionId: s.id }),
        undefined,
        adminCtx("acme-art"),
      ),
    );
    expect(ownerRes.artifacts.length).toBe(1);

    const otherRes = ok(
      await router.dispatch(
        createRequest(2, "session/artifacts/list", { sessionId: s.id }),
        undefined,
        adminCtx("other-art"),
      ),
    );
    expect(otherRes.artifacts.length).toBe(0);
  });
});
