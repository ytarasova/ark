/**
 * Tenant-scoped AppContext helpers.
 *
 * `forTenant()` returns a shallow copy of the parent AppContext with every
 * tenant-aware repository + store replaced by a per-tenant instance. All
 * instances share the same DB, container, and provider registries -- only
 * the reads/writes are scoped via the repo's `setTenant()`.
 *
 * Extracted from app.ts to keep the main class under 500 LOC.
 */
import type { AppContext } from "./app.js";
import {
  SessionRepository,
  ComputeRepository,
  ComputeTemplateRepository,
  EventRepository,
  MessageRepository,
  TodoRepository,
  ArtifactRepository,
  FlowStateRepository,
  LedgerRepository,
} from "./repositories/index.js";
import { KnowledgeStore } from "./knowledge/store.js";
import { DbResourceStore } from "./stores/db-resource-store.js";
import { UsageRecorder } from "./observability/usage.js";
import { ComputeService } from "./services/compute.js";

export function buildTenantScope(parent: AppContext, tenantId: string): AppContext {
  const scoped = Object.create(parent) as AppContext;
  const db = parent.db;

  const scopedSessions = new SessionRepository(db);
  scopedSessions.setTenant(tenantId);
  const scopedComputes = new ComputeRepository(db);
  scopedComputes.setTenant(tenantId);
  const scopedEvents = new EventRepository(db);
  scopedEvents.setTenant(tenantId);
  const scopedMessages = new MessageRepository(db);
  scopedMessages.setTenant(tenantId);
  const scopedTodos = new TodoRepository(db);
  scopedTodos.setTenant(tenantId);
  const scopedArtifacts = new ArtifactRepository(db);
  scopedArtifacts.setTenant(tenantId);
  const scopedFlowStates = new FlowStateRepository(db);
  scopedFlowStates.setTenant(tenantId);
  const scopedLedger = new LedgerRepository(db);
  scopedLedger.setTenant(tenantId);
  const scopedKnowledge = new KnowledgeStore(db);
  scopedKnowledge.setTenant(tenantId);
  const scopedComputeTemplates = new ComputeTemplateRepository(db);
  scopedComputeTemplates.setTenant(tenantId);
  const scopedUsage = new UsageRecorder(db, parent.pricing);
  scopedUsage.setTenant(tenantId);

  // Tenant-scoped ComputeService bound to the scoped `computes` repo. Without
  // this, callers reaching for `scoped.computeService.create(...)` would hit
  // the root container's service (default tenant) even though the caller
  // expects tenant-scoped writes.
  const scopedComputeService = new ComputeService(scopedComputes, parent);

  Object.defineProperty(scoped, "tenantId", { get: () => tenantId, configurable: true });
  Object.defineProperty(scoped, "sessions", { get: () => scopedSessions, configurable: true });
  Object.defineProperty(scoped, "computes", { get: () => scopedComputes, configurable: true });
  Object.defineProperty(scoped, "computeService", { get: () => scopedComputeService, configurable: true });
  Object.defineProperty(scoped, "computeTemplates", { get: () => scopedComputeTemplates, configurable: true });
  Object.defineProperty(scoped, "events", { get: () => scopedEvents, configurable: true });
  Object.defineProperty(scoped, "messages", { get: () => scopedMessages, configurable: true });
  Object.defineProperty(scoped, "todos", { get: () => scopedTodos, configurable: true });
  Object.defineProperty(scoped, "artifacts", { get: () => scopedArtifacts, configurable: true });
  Object.defineProperty(scoped, "flowStates", { get: () => scopedFlowStates, configurable: true });
  Object.defineProperty(scoped, "ledger", { get: () => scopedLedger, configurable: true });
  Object.defineProperty(scoped, "knowledge", { get: () => scopedKnowledge, configurable: true });
  Object.defineProperty(scoped, "usageRecorder", { get: () => scopedUsage, configurable: true });

  // DB-backed resource stores are only live in hosted mode. This is a DI-
  // composition-time check (creating the tenant scope's store wiring), not a
  // runtime branch, so it's allowed under the AppMode invariant.
  if (parent.mode.kind === "hosted") {
    const scopedAgents = new DbResourceStore(db, "agent", {
      description: "",
      model: "sonnet",
      max_turns: 200,
      system_prompt: "",
      tools: [],
      mcp_servers: [],
      skills: [],
      memories: [],
      context: [],
      permission_mode: "bypassPermissions",
      env: {},
    });
    scopedAgents.setTenant(tenantId);
    const scopedFlows = new DbResourceStore(db, "flow", { stages: [] });
    scopedFlows.setTenant(tenantId);
    const scopedSkills = new DbResourceStore(db, "skill", { description: "", content: "" });
    scopedSkills.setTenant(tenantId);
    const scopedRecipes = new DbResourceStore(db, "recipe", { description: "", flow: "default" });
    scopedRecipes.setTenant(tenantId);
    const scopedRuntimes = new DbResourceStore(db, "runtime", { description: "", type: "cli-agent", command: [] });
    scopedRuntimes.setTenant(tenantId);

    Object.defineProperty(scoped, "agents", { get: () => scopedAgents, configurable: true });
    Object.defineProperty(scoped, "flows", { get: () => scopedFlows, configurable: true });
    Object.defineProperty(scoped, "skills", { get: () => scopedSkills, configurable: true });
    Object.defineProperty(scoped, "recipes", { get: () => scopedRecipes, configurable: true });
    Object.defineProperty(scoped, "runtimes", { get: () => scopedRuntimes, configurable: true });
  }

  return scoped;
}
