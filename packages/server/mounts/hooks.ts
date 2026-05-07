/**
 * `/hooks/status` REST HTTP handler -- external compatibility mount.
 *
 * This endpoint must stay REST-accessible on the merged port (19400) for two
 * reasons:
 *   1. Agent runtimes (claude hooks, goose hooks) that launched before the
 *      JSON-RPC `hook/forward` was available may still POST here.
 *   2. `arkd-events-consumer` synthesises a Request object and calls this
 *      handler directly for frames received via the `hooks` channel.
 *
 * Business logic lives in `processHookPayload` (packages/core/services/channel/
 * hook-status.ts) so this is a thin HTTP wrapper.
 */

import type { AppContext } from "../../core/app.js";
import { handleHookStatusHttp } from "../../core/services/channel/hook-status-http.js";

export async function handleHookStatus(app: AppContext, req: Request, url: URL): Promise<Response> {
  return handleHookStatusHttp(app, req, url);
}
