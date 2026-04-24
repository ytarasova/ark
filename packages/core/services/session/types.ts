/**
 * Shared types + Deps interface for the session-lifecycle pipeline.
 *
 * `SessionLifecycleDeps` enumerates the narrow capabilities that the
 * sub-classes actually read. Callbacks wrap still-AppContext-taking
 * helpers (removeWorktree, gcCompute, deleteCredsSecret, ...) so the
 * class itself never sees AppContext. Those callbacks are wired at the
 * container-registration layer where a single `c.app` reference is
 * acceptable.
 */

import type { ArkConfig } from "../../config.js";
import type { Session, Compute, CreateSessionOpts } from "../../../types/index.js";
import type { SessionRepository } from "../../repositories/session.js";
import type { EventRepository } from "../../repositories/event.js";
import type { MessageRepository } from "../../repositories/message.js";
import type { TodoRepository } from "../../repositories/todo.js";
import type { ComputeRepository } from "../../repositories/compute.js";
import type { FlowStore } from "../../stores/flow-store.js";
import type { RuntimeStore } from "../../stores/runtime-store.js";
import type { UsageRecorder } from "../../observability/usage.js";
import type { StatusPollerRegistry } from "../../executors/status-poller.js";
import type { ComputeProvider } from "../../../compute/types.js";
import type { ComputeTarget } from "../../../compute/core/compute-target.js";
import type { CodeIntelStore } from "../../code-intel/store.js";

// ── Callbacks for helpers that still take AppContext ────────────────────────
// These wrap free functions that themselves take `app: AppContext` and reach
// into many cradle slots (workspace, compute-lifecycle, creds). Wiring them
// as narrow callbacks at container-reg time keeps the Lifecycle class free
// of AppContext entirely.

export interface DispatchCb {
  (sessionId: string): Promise<{ ok: boolean; message: string }>;
}
export interface RemoveWorktreeCb {
  (session: Session): Promise<void>;
}
export interface DeleteCredsSecretCb {
  (session: Session, compute: Compute | null): Promise<void>;
}
export interface GcComputeIfTemplateCb {
  (computeName: string | null | undefined): Promise<boolean>;
}
export interface ResolveProviderCb {
  (session: Session): Promise<{ provider: ComputeProvider | null; compute: Compute | null }>;
}
export interface ResolveComputeTargetCb {
  (session: Session): Promise<{ target: ComputeTarget | null; compute: Compute | null }>;
}
export interface AdvanceCb {
  (sessionId: string, force?: boolean): Promise<{ ok: boolean; message: string }>;
}

// ── Public result shapes (stable; re-exported from the barrel) ──────────────

export type SessionOpResult = { ok: true; sessionId: string } | { ok: false; message: string };

/**
 * Lifecycle hooks invoked by start/fork/clone after the session row is
 * persisted. `onCreated` is the opt-in broadcast point -- callers that want
 * the default-dispatcher listener to auto-kick pass
 * `{ onCreated: (id) => sessionService.emitSessionCreated(id) }`. Callers
 * that dispatch explicitly (conductor, cli/exec, stage-advance, issue-poller)
 * or don't want dispatch at all (tests) omit it.
 */
export interface LifecycleHooks {
  onCreated?: (sessionId: string) => void;
}

export interface VerificationResult {
  ok: boolean;
  todosResolved: boolean;
  pendingTodos: string[];
  scriptResults: Array<{ script: string; passed: boolean; output: string }>;
  message: string;
}

export type VerifyScriptRunner = (
  script: string,
  opts: { cwd?: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

// Re-export CreateSessionOpts-aligned start opts (with two local extras not
// in the canonical type: `config` as a loose record for templating inputs,
// and `attachments`).
export type StartSessionOpts = CreateSessionOpts;

// ── Deps ────────────────────────────────────────────────────────────────────

export interface SessionLifecycleDeps {
  // Repositories -- all reads/writes by the lifecycle methods
  sessions: SessionRepository;
  events: EventRepository;
  messages: MessageRepository;
  todos: TodoRepository;
  computes: ComputeRepository;

  // Stores -- flow / runtime lookups needed by start + verify + usage
  flows: FlowStore;
  runtimes: RuntimeStore;

  // Code-intel (workspace resolution on start). Resolved lazily -- tests
  // swap the backing store via `AppContext.codeIntel` getter, so we must
  // not snapshot the instance at container-resolve time.
  getCodeIntel: () => CodeIntelStore;

  // Config + usage recording
  config: ArkConfig;
  usageRecorder: UsageRecorder;

  statusPollers: StatusPollerRegistry;

  // Callbacks for helpers that still take AppContext.
  dispatch: DispatchCb;
  removeWorktree: RemoveWorktreeCb;
  deleteCredsSecret: DeleteCredsSecretCb;
  gcComputeIfTemplate: GcComputeIfTemplateCb;
  resolveProvider: ResolveProviderCb;
  resolveComputeTarget: ResolveComputeTargetCb;
  /** Stage-advance callback. Used by approveReviewGate to force-advance past a gate. */
  advance: AdvanceCb;
  /** Workspace provisioner (takes AppContext upstream; passed as a callback). */
  provisionWorkspaceWorkdir: (
    session: Session,
    workspace: { id: string; tenant_id: string; [k: string]: unknown },
    opts: { primaryRepoId: string | null },
  ) => Promise<string>;
}
