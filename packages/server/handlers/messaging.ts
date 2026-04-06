import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import type { MessageSendParams, SessionIdParams } from "../../types/index.js";

export function registerMessagingHandlers(router: Router, app: AppContext): void {
  router.handle("message/send", async (p) => {
    const { sessionId, content } = extract<MessageSendParams>(p, ["sessionId", "content"]);
    await core.send(sessionId, content);
    return { ok: true };
  });

  router.handle("gate/approve", async (p) => {
    const { sessionId } = extract<SessionIdParams>(p, ["sessionId"]);
    const result = await core.approveReviewGate(sessionId);
    return result;
  });

  router.handle("message/markRead", async (p) => {
    const { sessionId } = extract<SessionIdParams>(p, ["sessionId"]);
    core.markMessagesRead(sessionId);
    return { ok: true };
  });
}
