import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";
import type { BlobStore } from "../storage/blob-store.js";
import type { FlowStore } from "../stores/flow-store.js";
import type { ComputeRepository } from "../repositories/compute.js";
import type { ArkConfig } from "../config.js";
import type { SecretsCapability } from "../secrets/types.js";

/**
 * Narrow dependency set for orchestration functions.
 * Activities receive this at worker construction time instead of AppContext
 * so Temporal can serialize activity inputs at the workflow boundary.
 */
export interface OrchestrationDeps {
  sessions: SessionRepository;
  events: EventRepository;
  messages: MessageRepository;
  blobStore: BlobStore;
  flows: FlowStore;
  computes: ComputeRepository;
  config: ArkConfig;
  secrets: SecretsCapability;
  tenantId: string;
  arkDir: string;
  /**
   * Optional dispatch callback wired at worker bootstrap time.
   * Allows dispatchStageActivity to invoke the bespoke DispatchService without
   * holding a full AppContext reference. Phase 3 will replace this with a
   * self-contained DispatchDeps constructed from OrchestrationDeps.
   */
  dispatch?: (sessionId: string) => Promise<{ ok: boolean; message?: string; pid?: number; handle?: string }>;
}

/** Derive narrow deps from a full AppContext for local/transition use. */
export function depsFromApp(app: import("../app.js").AppContext): OrchestrationDeps {
  return {
    sessions: app.sessions,
    events: app.events,
    messages: app.messages,
    blobStore: app.blobStore,
    flows: app.flows,
    computes: app.computes,
    config: app.config,
    secrets: app.mode.secrets,
    tenantId: app.tenantId!,
    arkDir: app.arkDir,
    dispatch: (sessionId: string) => app.dispatchService.dispatch(sessionId),
  };
}
