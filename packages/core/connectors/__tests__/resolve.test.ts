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
    connectors: ["github", "jira"],
  } as any);
  // Ensure the test uses a fresh registry (decoupled from any cache).
  setConnectorRegistry(app, createDefaultConnectorRegistry());
});

afterAll(async () => {
  await app?.shutdown();
});

describe("flowConnectorsFor", () => {
  test("returns the connectors array from the flow YAML", () => {
    expect(flowConnectorsFor(app, "flow-with-connectors")).toEqual(["github", "jira"]);
  });

  test("returns [] for unknown flow", () => {
    expect(flowConnectorsFor(app, "does-not-exist")).toEqual([]);
  });

  test("returns [] for undefined flow name", () => {
    expect(flowConnectorsFor(app, undefined)).toEqual([]);
  });
});

describe("collectMcpEntries", async () => {
  test("returns empty array when no runtime or flow connectors declared", async () => {
    const session = await app.sessions.create({ summary: "x", flow: "flow-with-connectors" });
    const entries = collectMcpEntries(app, session, {});
    expect(entries).toEqual([]);
  });

  test("flow connectors resolve to configName or inline MCP entries", async () => {
    const session = await app.sessions.create({ summary: "x", flow: "flow-with-connectors" });
    const entries = collectMcpEntries(app, session, {
      flowConnectors: ["github", "jira"],
    });
    expect(entries).toContain("github");
    expect(entries).toContain("atlassian");
  });

  test("session connectors merge on top of flow", async () => {
    const session = await app.sessions.create({ summary: "x", flow: "flow-with-connectors" });
    const entries = collectMcpEntries(app, session, {
      flowConnectors: ["github"],
      sessionConnectors: ["jira"],
    });
    expect(entries).toHaveLength(2);
    expect(entries).toContain("github");
    expect(entries).toContain("atlassian");
  });

  test("unknown connector names are ignored silently", async () => {
    const session = await app.sessions.create({ summary: "x", flow: "flow-with-connectors" });
    const entries = collectMcpEntries(app, session, {
      flowConnectors: ["unknown", "github"],
    });
    expect(entries).toEqual(["github"]);
  });

  test("applied connectors are persisted to session.config.applied_connectors", async () => {
    const session = await app.sessions.create({ summary: "x", flow: "flow-with-connectors" });
    collectMcpEntries(app, session, { flowConnectors: ["github"], sessionConnectors: ["jira"] });
    const reloaded = await app.sessions.get(session.id);
    const cfg = (reloaded?.config ?? {}) as { applied_connectors?: string[] };
    expect(cfg.applied_connectors).toEqual(["github", "jira"]);
  });
});
