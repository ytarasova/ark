/**
 * Connector resolution tests.
 *
 * Covers `collectMcpEntries` (runtime + flow + session opt-ins merged) and
 * `flowConnectorsFor` reading the connectors array off a saved flow YAML.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppContext } from "../../app.js";
import { collectMcpEntries, flowConnectorsFor } from "../resolve.js";
import { createDefaultConnectorRegistry } from "../registry.js";
import { setConnectorRegistry } from "../resolve.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  app.flows.save("flow-with-connectors", {
    name: "flow-with-connectors",
    stages: [{ name: "work", agent: "worker", gate: "auto" }],
    connectors: ["pi-sage", "jira"],
  } as any);
  // Ensure the test uses a fresh registry (decoupled from any cache).
  setConnectorRegistry(app, createDefaultConnectorRegistry());
});

afterAll(async () => {
  await app?.shutdown();
});

describe("flowConnectorsFor", () => {
  test("returns the connectors array from the flow YAML", () => {
    expect(flowConnectorsFor(app, "flow-with-connectors")).toEqual(["pi-sage", "jira"]);
  });

  test("returns [] for unknown flow", () => {
    expect(flowConnectorsFor(app, "does-not-exist")).toEqual([]);
  });

  test("returns [] for undefined flow name", () => {
    expect(flowConnectorsFor(app, undefined)).toEqual([]);
  });
});

describe("collectMcpEntries", () => {
  test("returns empty array when no runtime or flow connectors declared", () => {
    const session = app.sessions.create({ summary: "x", flow: "flow-with-connectors" });
    const entries = collectMcpEntries(app, session, {});
    expect(entries).toEqual([]);
  });

  test("flow connectors resolve to configName or inline MCP entries", () => {
    const session = app.sessions.create({ summary: "x", flow: "flow-with-connectors" });
    const entries = collectMcpEntries(app, session, {
      flowConnectors: ["pi-sage", "jira"],
    });
    expect(entries).toContain("pi-sage");
    expect(entries).toContain("atlassian");
  });

  test("session connectors merge on top of flow", () => {
    const session = app.sessions.create({ summary: "x", flow: "flow-with-connectors" });
    const entries = collectMcpEntries(app, session, {
      flowConnectors: ["pi-sage"],
      sessionConnectors: ["jira"],
    });
    expect(entries).toHaveLength(2);
    expect(entries).toContain("pi-sage");
    expect(entries).toContain("atlassian");
  });

  test("unknown connector names are ignored silently", () => {
    const session = app.sessions.create({ summary: "x", flow: "flow-with-connectors" });
    const entries = collectMcpEntries(app, session, {
      flowConnectors: ["unknown", "pi-sage"],
    });
    expect(entries).toEqual(["pi-sage"]);
  });

  test("applied connectors are persisted to session.config.applied_connectors", () => {
    const session = app.sessions.create({ summary: "x", flow: "flow-with-connectors" });
    collectMcpEntries(app, session, { flowConnectors: ["pi-sage"], sessionConnectors: ["jira"] });
    const reloaded = app.sessions.get(session.id);
    const cfg = (reloaded?.config ?? {}) as { applied_connectors?: string[] };
    expect(cfg.applied_connectors).toEqual(["pi-sage", "jira"]);
  });
});
