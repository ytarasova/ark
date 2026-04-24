import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { resolveTenantApp } from "./scope-helpers.js";
import type { MessageSendParams, SessionIdParams } from "../../types/index.js";

export function registerMessagingHandlers(router: Router, app: AppContext): void {
  router.handle("message/send", async (p, _notify, ctx) => {
    const { sessionId, content } = extract<MessageSendParams>(p, ["sessionId", "content"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.send(sessionId, content);
    return result;
  });

  router.handle("gate/approve", async (p, _notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(p, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    const result = await scoped.sessionService.approveReviewGate(sessionId);
    return result;
  });

  router.handle("gate/reject", async (p, _notify, ctx) => {
    const { sessionId, reason } = p as { sessionId?: string; reason?: string };
    if (!sessionId) throw new Error("Missing required parameter: sessionId");
    const scoped = resolveTenantApp(app, ctx);
    return await scoped.sessionService.rejectReviewGate(sessionId, reason ?? "");
  });

  router.handle("message/markRead", async (p, _notify, ctx) => {
    const { sessionId } = extract<SessionIdParams>(p, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    await scoped.messages.markRead(sessionId);
    return { ok: true };
  });

  router.handle("session/unread-counts", async (_p, _notify, ctx) => {
    const scoped = resolveTenantApp(app, ctx);
    const counts = await scoped.messages.unreadCounts();
    return { counts };
  });
}
