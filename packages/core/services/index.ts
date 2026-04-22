// Side-effect import: wires cross-module deps for worktree.finishWorktree.
// Must run before any caller invokes finishWorktree. See init.ts for details.
import "./init.js";

export { SessionService } from "./session.js";
export { SessionHooks } from "./session-hooks/index.js";
export type { HookStatusResult, ReportResult, StageHandoffResult } from "./session-hooks/index.js";
export type { SessionOpResult } from "../../types/index.js";
export { ComputeService } from "./compute.js";
export { HistoryService } from "./history.js";
export type { HistorySearchResult } from "./history.js";
