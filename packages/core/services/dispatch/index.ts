/**
 * DispatchService -- thin class wrapper over the legacy free-function
 * `dispatch()` and `resume()`. Exists so callers can write
 * `app.dispatchService.dispatch(id)` without worrying about whether the
 * class-based refactor has landed. The class body holds a single
 * AppContext reference so the underlying free functions can be invoked.
 */

import type { AppContext } from "../../app.js";
import { dispatch, resume } from "../dispatch.js";

export { dispatch, resume } from "../dispatch.js";

export class DispatchService {
  constructor(private readonly app: AppContext) {}
  dispatch(sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<{ ok: boolean; message: string }> {
    return dispatch(this.app, sessionId, opts);
  }
  resume(sessionId: string): Promise<{ ok: boolean; message: string }> {
    return resume(this.app, sessionId);
  }
}
