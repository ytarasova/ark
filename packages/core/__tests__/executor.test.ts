import { describe, it, expect, beforeEach } from "bun:test";
import { registerExecutor, getExecutor, listExecutors, resetExecutors } from "../executor.js";
import type { Executor } from "../executor.js";

function stubExecutor(name: string): Executor {
  return {
    name,
    launch: async () => ({ ok: true, handle: "h-1" }),
    kill: async () => {},
    status: async () => ({ state: "not_found" as const }),
    send: async () => {},
    capture: async () => "",
  };
}

describe("executor registry", () => {
  beforeEach(() => resetExecutors());

  it("registers and retrieves an executor", () => {
    const ex = stubExecutor("test-exec");
    registerExecutor(ex);
    expect(getExecutor("test-exec")).toBe(ex);
  });

  it("returns undefined for unknown executor", () => {
    expect(getExecutor("nonexistent")).toBeUndefined();
  });

  it("lists all registered executors", () => {
    registerExecutor(stubExecutor("a"));
    registerExecutor(stubExecutor("b"));
    expect(
      listExecutors()
        .map((e) => e.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("overwrites executor with same name", () => {
    const ex1 = stubExecutor("dup");
    const ex2 = stubExecutor("dup");
    registerExecutor(ex1);
    registerExecutor(ex2);
    expect(getExecutor("dup")).toBe(ex2);
  });
});
