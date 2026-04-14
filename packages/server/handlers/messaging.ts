import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
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

  router.handle("message/markRead", async (p) => {
    const { sessionId } = extract<SessionIdParams>(p, ["sessionId"]);
    app.messages.markRead(sessionId);
    return { ok: true };
  });
}
