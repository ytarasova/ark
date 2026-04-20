import { describe, expect, test } from "bun:test";
import { ConnectorRegistry, createDefaultConnectorRegistry, builtinConnectors } from "../registry.js";
import { piSageConnector } from "../definitions/pi-sage.js";

describe("ConnectorRegistry", () => {
  test("default registry holds every shipped connector", () => {
    const reg = createDefaultConnectorRegistry();
    for (const c of builtinConnectors()) {
      expect(reg.get(c.name)?.name).toBe(c.name);
    }
  });

  test("get returns null for unknown", () => {
    expect(createDefaultConnectorRegistry().get("nope")).toBeNull();
  });

  test("register replaces existing entry", () => {
    const reg = createDefaultConnectorRegistry();
    reg.register({ ...piSageConnector, label: "Replaced" });
    expect(reg.get("pi-sage")?.label).toBe("Replaced");
  });

  test("resolveMcpEntries returns shipped configName for full MCP connector", () => {
    const reg = createDefaultConnectorRegistry();
    const entries = reg.resolveMcpEntries(["pi-sage"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].entry).toBe("pi-sage");
    expect(entries[0].fromConnector).toBe("pi-sage");
  });

  test("resolveMcpEntries returns inline object for scaffolded connector", () => {
    const reg = createDefaultConnectorRegistry();
    const entries = reg.resolveMcpEntries(["bitbucket"]);
    expect(entries).toHaveLength(1);
    expect(typeof entries[0].entry).toBe("object");
    const inline = entries[0].entry as Record<string, unknown>;
    expect(Object.keys(inline)).toEqual(["bitbucket"]);
  });

  test("resolveMcpEntries skips unknown connectors silently", () => {
    const reg = createDefaultConnectorRegistry();
    const entries = reg.resolveMcpEntries(["pi-sage", "missing"]);
    expect(entries).toHaveLength(1);
  });

  test("resolveContextConnectors returns only kind=context entries", () => {
    const reg = new ConnectorRegistry();
    reg.register({
      name: "ctx",
      kind: "context",
      status: "full",
      label: "ctx",
      context: {
        async build() {
          return "hello";
        },
      },
    });
    reg.register(piSageConnector);
    expect(reg.resolveContextConnectors(["pi-sage", "ctx"]).map((c) => c.name)).toEqual(["ctx"]);
  });

  test("MCP connectors do not show up in resolveContextConnectors", () => {
    const reg = createDefaultConnectorRegistry();
    expect(reg.resolveContextConnectors(["pi-sage", "jira"])).toHaveLength(0);
  });
});

describe("connector definitions ship the expected configs", () => {
  test("pi-sage maps to mcp-configs/pi-sage.json", () => {
    expect(piSageConnector.mcp?.configName).toBe("pi-sage");
  });

  test("jira reuses atlassian config", () => {
    const jira = builtinConnectors().find((c) => c.name === "jira");
    expect(jira?.mcp?.configName).toBe("atlassian");
  });

  test("bitbucket + slack are scaffolded with inline stubs", () => {
    for (const name of ["bitbucket", "slack"]) {
      const c = builtinConnectors().find((x) => x.name === name);
      expect(c?.status).toBe("scaffolded");
      expect(c?.mcp?.inline).toBeDefined();
    }
  });
});
