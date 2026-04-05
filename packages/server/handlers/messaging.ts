import type { Router } from "../router.js";
import * as core from "../../core/index.js";

export function registerMessagingHandlers(router: Router): void {
  router.handle("message/send", async (p) => {
    await core.send(p.sessionId as string, p.content as string);
    return { ok: true };
  });

  router.handle("gate/approve", async (p) => {
    const result = await core.approveReviewGate(p.sessionId as string);
    return result;
  });
}
