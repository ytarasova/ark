/**
 * Channel-report processing pipeline.
 *
 * The `/api/channel/:sessionId` route and the `/hooks/status` non-hook
 * passthrough both feed reports through `handleReport`. This module owns
 * that pipeline: log events, persist messages, emit bus events, apply
 * store updates, run stage handoff, and trigger completion side-effects
 * (notifications, artifact tracking, auto-PR).
 */

import type { AppContext } from "../../app.js";
import type { OutboundMessage } from "../common/channel-types.js";
import { handleReport as handleReportSignal } from "../../services/session-signals.js";

export async function handleReport(app: AppContext, sessionId: string, report: OutboundMessage): Promise<void> {
  return handleReportSignal(app, sessionId, report);
}
