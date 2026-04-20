/**
 * JSON-RPC handlers for the connector registry.
 *
 * Methods covered: connectors/list, connectors/get, connectors/test.
 * The handlers wrap `getConnectorRegistry(app)` (a per-AppContext WeakMap
 * cache) so two AppContexts hold independent registries.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerConnectorHandlers } from "../handlers/connectors.js";
import {
  ConnectorRegistry,
  setConnectorRegistry,
  getConnectorRegistry,
  builtinConnectors,
} from "../../core/connectors/index.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

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
  registerConnectorHandlers(router, app);
});

function asResult(r: unknown): Record<string, unknown> {
  return (r as JsonRpcResponse).result as Record<string, unknown>;
}

describe("connectors/* JSON-RPC handlers", () => {
  it("connectors/list returns one entry per registered connector with the expected shape", async () => {
    const res = asResult(await router.dispatch(createRequest(1, "connectors/list", {})));
    const list = res.connectors as Array<{
      name: string;
      kind: string;
      label: string;
      status: string;
      mcp: { configName?: string; configPath?: string | null; hasInline?: boolean } | null;
      auth: { kind: string; envVar?: string } | null;
    }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(builtinConnectors().length);

    // Required fields are present.
    for (const c of list) {
      expect(typeof c.name).toBe("string");
      expect(["mcp", "rest", "context"]).toContain(c.kind);
      expect(["full", "scaffolded", "stub"]).toContain(c.status);
      expect(typeof c.label).toBe("string");
    }

    // pi-sage is one of the shipped connectors.
    const sage = list.find((c) => c.name === "pi-sage");
    expect(sage).toBeDefined();
    expect(sage?.kind).toBe("mcp");
    expect(sage?.mcp?.configName).toBe("pi-sage");
    expect(sage?.auth?.envVar).toBe("PI_SAGE_TOKEN");
  });

  it("connectors/get returns the connector view for a known name", async () => {
    const res = asResult(await router.dispatch(createRequest(2, "connectors/get", { name: "github" })));
    const c = res.connector as { name: string; kind: string; status: string };
    expect(c.name).toBe("github");
    expect(c.kind).toBe("mcp");
    expect(c.status).toBe("full");
  });

  it("connectors/get returns an RPC error for an unknown connector", async () => {
    const res = await router.dispatch(createRequest(3, "connectors/get", { name: "definitely-not-real" }));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.message).toMatch(/not found/i);
  });

  it("connectors/test returns {reachable, details} without spawning the connector", async () => {
    const res = asResult(await router.dispatch(createRequest(4, "connectors/test", { name: "bitbucket" })));
    expect(res.name).toBe("bitbucket");
    expect(typeof res.reachable).toBe("boolean");
    expect(typeof res.details).toBe("string");
    // bitbucket is scaffolded with an inline config -> probe says reachable.
    expect(res.reachable).toBe(true);
    expect(res.details).toMatch(/inline MCP/i);
  });

  it("tenant scope: per-AppContext registry (test hook overrides do not leak across apps)", async () => {
    // Replace the registry on `app` with an empty one and verify connectors/list
    // returns nothing -- proving the handler reads through getConnectorRegistry(app).
    const empty = new ConnectorRegistry();
    setConnectorRegistry(app, empty);

    const res = asResult(await router.dispatch(createRequest(5, "connectors/list", {})));
    expect((res.connectors as unknown[]).length).toBe(0);

    // A fresh AppContext keeps its own registry -- it must not see `empty`.
    const otherApp = await AppContext.forTestAsync();
    await otherApp.boot();
    try {
      expect(getConnectorRegistry(otherApp).list().length).toBe(builtinConnectors().length);
    } finally {
      await otherApp.shutdown();
    }
  });
});
