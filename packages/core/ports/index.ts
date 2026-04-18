/**
 * Port catalog for the hexagonal core.
 *
 * Every port here is a pure TypeScript interface -- no runtime imports from
 * `fs`, `child_process`, or `bun:sqlite` are allowed inside this directory.
 * The ESLint boundary rule in the repo root enforces that constraint.
 *
 * Existing ports that already live elsewhere (`SessionLauncher`,
 * `ComputeProvider`, resource stores) are re-exported from here so callers
 * can depend on a single catalog rather than guessing which package owns a
 * given interface. The authoritative files are NOT moved in this PR.
 */

// New ports defined in this directory.
export type { SessionStore } from "./session-store.js";
export type { ComputeStore, ComputeListFilters } from "./compute-store.js";
export type { EventBus, ArkEvent, EventHandler, BeforeHandler } from "./event-bus.js";
export type { EventStore, EventLogOpts, EventListOpts } from "./event-store.js";
export type {
  Workspace,
  WorkspaceSetupOpts,
  WorkspaceSetupResult,
  CreatePROpts,
  CreatePRResult,
  CopyFilesOpts,
} from "./workspace.js";
export type { ProcessRunner, RunOpts, RunResult } from "./process-runner.js";
export type { Clock } from "./clock.js";
export type { Logger, LogLevel, LogFields } from "./logger.js";
export type { Tracer, Span, SpanAttrs } from "./tracer.js";
export type { SecretStore } from "./secret-store.js";

// Existing ports kept in their current homes; re-exported for convenience.
export type { SessionLauncher, LaunchResult } from "../session-launcher.js";
export type { ComputeProvider } from "../../compute/types.js";
export type { FlowStore, FlowSummary } from "../stores/flow-store.js";
export type { AgentStore } from "../stores/agent-store.js";
export type { SkillStore } from "../stores/skill-store.js";
export type { RecipeStore } from "../stores/recipe-store.js";
export type { RuntimeStore } from "../stores/runtime-store.js";
