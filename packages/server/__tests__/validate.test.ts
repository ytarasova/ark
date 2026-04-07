import { describe, it, expect } from "bun:test";
import { extract, rpcError } from "../validate.js";
import { RpcError } from "../../protocol/types.js";

describe("extract<T>", () => {
  it("returns params when all required keys present", () => {
    const params = { sessionId: "s-1", force: true };
    const result = extract<{ sessionId: string; force: boolean }>(params, ["sessionId", "force"]);
    expect(result.sessionId).toBe("s-1");
    expect(result.force).toBe(true);
  });

  it("throws with code -32602 when params undefined", () => {
    try {
      extract<{ sessionId: string }>(undefined, ["sessionId"]);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toBe("Missing params");
      expect(err.code).toBe(-32602);
    }
  });

  it("throws when a required key is missing", () => {
    try {
      extract<{ sessionId: string; name: string }>({ sessionId: "s-1" }, ["sessionId", "name"]);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toBe("Missing required param: name");
      expect(err.code).toBe(-32602);
    }
  });

  it("passes through extra keys", () => {
    const params = { sessionId: "s-1", extra: "bonus" };
    const result = extract<{ sessionId: string }>(params, ["sessionId"]);
    expect(result.sessionId).toBe("s-1");
    expect((result as Record<string, unknown>).extra).toBe("bonus");
  });

  it("works with empty required array", () => {
    const params = { anything: "goes" };
    const result = extract<Record<string, unknown>>(params, []);
    expect(result.anything).toBe("goes");
  });
});

describe("rpcError", () => {
  it("creates error with code property", () => {
    const err = rpcError(-32600, "Invalid request");
    expect(err.message).toBe("Invalid request");
    expect((err as RpcError).code).toBe(-32600);
    expect(err instanceof Error).toBe(true);
  });
});
