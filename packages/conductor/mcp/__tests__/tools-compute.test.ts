import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;
beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("compute_list", () => {
  it("includes the builtin local compute", async () => {
    const result = (await h.callTool("compute_list", {})) as { name: string }[];
    expect(result.find((c) => c.name === "local")).toBeDefined();
  });

  it("does NOT leak sensitive config fields", async () => {
    const result = (await h.callTool("compute_list", {})) as Record<string, unknown>[];
    for (const c of result) {
      // The summary keys are limited to: name, compute_kind, isolation_kind, status, ip
      expect(Object.keys(c).sort()).toEqual(["compute_kind", "ip", "isolation_kind", "name", "status"]);
    }
  });
});

describe("compute_show", () => {
  it("returns the local compute", async () => {
    const result = (await h.callTool("compute_show", { name: "local" })) as { name: string };
    expect(result.name).toBe("local");
  });

  it("errors on unknown compute", async () => {
    let err: unknown = null;
    try {
      await h.callTool("compute_show", { name: "no-such-compute" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
  });
});
