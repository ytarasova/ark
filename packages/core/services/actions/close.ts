import type { ActionHandler } from "./types.js";

/**
 * `close_ticket` (alias `close`) -- no-op sentinel that just records the event.
 * Flows use this to mark "this stage completes without side effects"; the
 * stage chainer still advances to the next stage.
 */
export const closeAction: ActionHandler = {
  name: "close_ticket",
  aliases: ["close"],
  async execute(app, session, action, _opts) {
    await app.events.log(session.id, "action_executed", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { action },
    });
    return { ok: true, message: `Action '${action}' executed` };
  },
};
