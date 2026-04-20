/**
 * Unified integrations registry.
 *
 * An "integration" = one external system Ark talks to. Each integration
 * can expose two opt-in halves:
 *
 *   - trigger  : inbound events (webhook / schedule / poll / event) that
 *                kick a flow dispatch. Backed by TriggerSource connectors
 *                under `packages/core/triggers/sources/`.
 *   - connector: outbound tools for agents (MCP) + optional context build.
 *                Backed by Connector definitions under
 *                `packages/core/connectors/definitions/`.
 *
 * Not every integration exposes both. `alertmanager` is trigger-only;
 * internal-only tooling might be connector-only. Many integrations (github,
 * jira, slack, bitbucket, linear, pi-sage) expose both halves.
 *
 * This module is NOT a runtime dispatch path -- the webhook handler still
 * goes through `TriggerSourceRegistry`, and the MCP merge still goes
 * through `ConnectorRegistry`. The integration registry is the single
 * lookup surface for "does Ark talk to <name>? how?" and for UI / docs.
 *
 * Legacy integrations that live side-by-side (github-pr.ts, pr-poller.ts,
 * issue-poller.ts) remain importable via `./index.js`; extending the
 * registry below is the path forward.
 */

import { createDefaultRegistry as createDefaultTriggerRegistry } from "../triggers/registry.js";
import { createDefaultConnectorRegistry } from "../connectors/registry.js";
import type { TriggerSource } from "../triggers/types.js";
import type { Connector } from "../connectors/types.js";

export type IntegrationStatus = "full" | "scaffolded" | "stub";

export interface Integration {
  /** Unique integration name (e.g. "github", "pi-sage", "alertmanager"). */
  name: string;
  /** Human-readable label. */
  label: string;
  /** Highest-precedence maturity across the registered halves. */
  status: IntegrationStatus;
  trigger?: TriggerSource;
  connector?: Connector;
  /** Free-form auth descriptor -- present when either half declares one. */
  auth?: {
    /** Env var conventionally used for this integration. */
    envVar?: string;
    /** Trigger-side signing secret env var (if different). */
    triggerSecretEnvVar?: string;
  };
}

/**
 * The default integration catalog -- seeded from the trigger registry +
 * connector registry. One integration = same name in both halves (or just
 * one half present).
 */
export function buildIntegrationCatalog(): Integration[] {
  const triggers = createDefaultTriggerRegistry().list();
  const connectors = createDefaultConnectorRegistry().list();
  const byName = new Map<string, Integration>();

  for (const t of triggers) {
    const entry = byName.get(t.name) ?? makeEntry(t.name);
    entry.trigger = t;
    entry.label = t.label || entry.label;
    entry.status = mergeStatus(entry.status, t.status);
    entry.auth = { ...entry.auth, triggerSecretEnvVar: t.secretEnvVar };
    byName.set(t.name, entry);
  }
  for (const c of connectors) {
    const entry = byName.get(c.name) ?? makeEntry(c.name);
    entry.connector = c;
    entry.label = c.label || entry.label;
    entry.status = mergeStatus(entry.status, c.status);
    if (c.auth?.kind === "env" && c.auth.envVar) {
      entry.auth = { ...entry.auth, envVar: c.auth.envVar };
    }
    byName.set(c.name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function makeEntry(name: string): Integration {
  return { name, label: name, status: "stub" };
}

/**
 * Pick the most mature status. Order: full > scaffolded > stub.
 */
function mergeStatus(a: IntegrationStatus, b: IntegrationStatus): IntegrationStatus {
  const rank: Record<IntegrationStatus, number> = { full: 2, scaffolded: 1, stub: 0 };
  return rank[a] >= rank[b] ? a : b;
}

/** Find one integration by name in the default catalog. */
export function getIntegration(name: string): Integration | null {
  return buildIntegrationCatalog().find((i) => i.name === name) ?? null;
}

/** List every integration (triggers + connectors unioned by name). */
export function listIntegrations(): Integration[] {
  return buildIntegrationCatalog();
}
