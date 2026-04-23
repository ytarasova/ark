import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import type { MessageSendParams, SessionIdParams } from "../../types/index.js";

export function registerMessagingHandlers(router: Router, app: AppContext): void {
  router.handle("message/send", async (p) => {
    const { sessionId, content } = extract<MessageSendParams>(p, ["sessionId", "content"]);
    const result = await app.sessionService.send(sessionId, content);
    return result;
  });

  router.handle("gate/approve", async (p) => {
    const { sessionId } = extract<SessionIdParams>(p, ["sessionId"]);
    const result = await app.sessionService.approveReviewGate(sessionId);
    return result;
  });

  router.handle("gate/reject", async (p) => {
    const { sessionId, reason } = p as { sessionId?: string; reason?: string };
    if (!sessionId) throw new RpcError("Missing required parameter: sessionId", ErrorCodes.INVALID_PARAMS);
    return await app.sessionService.rejectReviewGate(sessionId, reason ?? "");
  });

  router.handle("message/markRead", async (p) => {
    const { sessionId } = extract<SessionIdParams>(p, ["sessionId"]);
    await app.messages.markRead(sessionId);
    return { ok: true };
  });

  router.handle("session/unread-counts", async () => {
    const counts = await app.messages.unreadCounts();
    return { counts };
  });
}
