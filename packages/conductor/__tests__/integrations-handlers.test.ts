/**
 * JSON-RPC handler for the unified integration catalog.
 *
 * Method covered: integrations/list. The handler shells out to
 * `buildIntegrationCatalog()` which unions the default trigger registry +
 * default connector registry.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerIntegrationsHandlers } from "../handlers/integrations.js";
import { createRequest, type JsonRpcResponse } from "../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerIntegrationsHandlers(router, app);
});

interface IntegrationView {
  name: string;
  label: string;
  status: string;
  has_trigger: boolean;
  has_connector: boolean;
  trigger_kind: string | null;
  connector_kind: string | null;
  auth: { envVar?: string; triggerSecretEnvVar?: string } | null;
}

function listIntegrations(): Promise<IntegrationView[]> {
  return router.dispatch(createRequest(1, "integrations/list", {})).then((res) => {
    const r = (res as JsonRpcResponse).result as { integrations: IntegrationView[] };
    return r.integrations;
  });
}

describe("integrations/* JSON-RPC handlers", async () => {
  it("integrations/list returns the paired catalog as a non-empty array", async () => {
    const list = await listIntegrations();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  it("each entry carries name + has_trigger + has_connector + maturity (status)", async () => {
    const list = await listIntegrations();
    for (const entry of list) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.has_trigger).toBe("boolean");
      expect(typeof entry.has_connector).toBe("boolean");
      expect(["full", "scaffolded", "stub"]).toContain(entry.status);
      // At least one of the halves must be present -- we don't surface ghost
      // integrations.
      expect(entry.has_trigger || entry.has_connector).toBe(true);
    }
  });

  it("pagerduty entry shows trigger-only (no connector half)", async () => {
    const list = await listIntegrations();
    const pd = list.find((e) => e.name === "pagerduty");
    expect(pd).toBeDefined();
    expect(pd?.has_trigger).toBe(true);
    expect(pd?.has_connector).toBe(false);
    expect(pd?.connector_kind).toBeNull();
    expect(pd?.trigger_kind).toBe("webhook");
  });
});
