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

  test("resolveMcpEntries picks up connectors that omit the legacy kind field", () => {
    const reg = new ConnectorRegistry();
    // Surfaces ARE the discriminator -- no `kind`, just an `mcp` surface.
    reg.register({
      name: "kindless-mcp",
      status: "full",
      label: "Kindless MCP",
      mcp: { configName: "kindless-mcp" },
    });
    const entries = reg.resolveMcpEntries(["kindless-mcp"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].entry).toBe("kindless-mcp");
    expect(entries[0].fromConnector).toBe("kindless-mcp");
  });

  test("resolveContextConnectors picks up connectors that omit the legacy kind field", () => {
    const reg = new ConnectorRegistry();
    reg.register({
      name: "kindless-ctx",
      status: "full",
      label: "Kindless ctx",
      context: {
        async build() {
          return "prefill";
        },
      },
    });
    expect(reg.resolveContextConnectors(["kindless-ctx"]).map((c) => c.name)).toEqual(["kindless-ctx"]);
  });
});

describe("ConnectorRegistry surface accessors (Wave 0)", () => {
  test("api() returns null for a connector without an api factory", () => {
    const reg = createDefaultConnectorRegistry();
    expect(reg.api("pi-sage")).toBeNull();
  });

  test("api() invokes the factory and returns the client", () => {
    const reg = new ConnectorRegistry();
    let factoryCalls = 0;
    const fakeClient = { hello: "world" };
    reg.register({
      name: "custom",
      label: "Custom",
      status: "full",
      api: () => {
        factoryCalls++;
        return fakeClient;
      },
    });
    expect(reg.api<typeof fakeClient>("custom")).toBe(fakeClient);
    expect(factoryCalls).toBe(1);
  });

  test("webhook() returns null when a connector has no webhook slot", () => {
    const reg = createDefaultConnectorRegistry();
    expect(reg.webhook("jira")).toBeNull();
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
