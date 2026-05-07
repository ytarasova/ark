/**
 * JSON-RPC handler for the unified integration catalog.
 *
 * Methods:
 *   integrations/list -> paired trigger + connector view, one row per name
 *
 * The catalog is built by `buildIntegrationCatalog()` which seeds from the
 * default trigger registry + connector registry. This handler serialises
 * the result to a JSON-safe shape so the Web UI can render a single "pairs"
 * table with maturity badges + auth hints without knowing the internal
 * trigger/connector interfaces.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { buildIntegrationCatalog, type Integration } from "../../core/integrations/registry.js";

interface IntegrationView {
  name: string;
  label: string;
  status: Integration["status"];
  has_trigger: boolean;
  has_connector: boolean;
  trigger_kind: string | null;
  connector_kind: string | null;
  auth: { envVar?: string; triggerSecretEnvVar?: string } | null;
}

function view(entry: Integration): IntegrationView {
  return {
    name: entry.name,
    label: entry.label,
    status: entry.status,
    has_trigger: !!entry.trigger,
    has_connector: !!entry.connector,
    // Trigger sources in this codebase are always HTTP webhook receivers;
    // surface that literally to the UI. Poll / schedule / event kinds are
    // per-config (TriggerConfig.kind), not per-source, so we don't know
    // here without reading the YAML.
    trigger_kind: entry.trigger ? "webhook" : null,
    connector_kind: entry.connector ? entry.connector.kind : null,
    auth: entry.auth ?? null,
  };
}

export function registerIntegrationsHandlers(router: Router, _app: AppContext): void {
  router.handle("integrations/list", async () => {
    return { integrations: buildIntegrationCatalog().map(view) };
  });
}
