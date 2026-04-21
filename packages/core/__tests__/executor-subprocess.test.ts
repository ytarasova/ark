import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { subprocessExecutor } from "../executors/subprocess.js";
import { waitFor } from "./test-helpers.js";

let app: AppContext;
beforeEach(async () => {
  if (app) {
    await app.shutdown();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterEach(async () => {
  if (app) {
    await app.shutdown();
  }
});

describe("subprocess executor", async () => {
  it("has correct name", () => {
    expect(subprocessExecutor.name).toBe("subprocess");
  });

  it("launches a simple command and captures output", async () => {
    const result = await subprocessExecutor.launch({
      sessionId: "s-test",
      workdir: "/tmp",
      agent: {
        name: "test-agent",
        model: "none",
        max_turns: 1,
        system_prompt: "",
        tools: [],
        skills: [],
        mcp_servers: [],
        permission_mode: "bypassPermissions",
        env: {},
        command: ["echo", "hello executor"],
      },
      task: "test task",
    });

    expect(result.ok).toBe(true);
    expect(result.handle).toBeTruthy();

    // Wait for process to actually exit, not a fixed sleep
    await waitFor(async () => (await subprocessExecutor.status(result.handle)).state === "completed", {
      timeout: 5000,
      message: "echo subprocess never completed",
    });

    const output = await subprocessExecutor.capture(result.handle);
    expect(output).toContain("hello executor");
  });

  it("reports completed status after process exits", async () => {
    const result = await subprocessExecutor.launch({
      sessionId: "s-done",
      workdir: "/tmp",
      agent: {
        name: "quick",
        model: "none",
        max_turns: 1,
        system_prompt: "",
        tools: [],
        skills: [],
        mcp_servers: [],
        permission_mode: "bypassPermissions",
        env: {},
        command: ["true"],
      },
      task: "noop",
    });

    await waitFor(async () => (await subprocessExecutor.status(result.handle)).state === "completed", {
      timeout: 5000,
      message: "true subprocess never completed",
    });
    const status = await subprocessExecutor.status(result.handle);
    expect(status.state).toBe("completed");
    if (status.state === "completed") {
      expect(status.exitCode).toBe(0);
    }
  });

  it("reports failed status for bad exit code", async () => {
    const result = await subprocessExecutor.launch({
      sessionId: "s-fail",
      workdir: "/tmp",
      agent: {
        name: "failing",
        model: "none",
        max_turns: 1,
        system_prompt: "",
        tools: [],
        skills: [],
        mcp_servers: [],
        permission_mode: "bypassPermissions",
        env: {},
        command: ["false"],
      },
      task: "will fail",
    });

    await waitFor(async () => (await subprocessExecutor.status(result.handle)).state === "failed", {
      timeout: 5000,
      message: "false subprocess never failed",
    });
    const status = await subprocessExecutor.status(result.handle);
    expect(status.state).toBe("failed");
  });

  it("returns not_found for unknown handle", async () => {
    const status = await subprocessExecutor.status("nonexistent-handle");
    expect(status.state).toBe("not_found");
  });

  it("kill terminates running process", async () => {
    const result = await subprocessExecutor.launch({
      sessionId: "s-kill",
      workdir: "/tmp",
      agent: {
        name: "sleeper",
        model: "none",
        max_turns: 1,
        system_prompt: "",
        tools: [],
        skills: [],
        mcp_servers: [],
        permission_mode: "bypassPermissions",
        env: {},
        command: ["sleep", "60"],
      },
      task: "sleep forever",
    });

    const statusBefore = await subprocessExecutor.status(result.handle);
    expect(statusBefore.state).toBe("running");

    await subprocessExecutor.kill(result.handle);
    await waitFor(
      async () => {
        const s = (await subprocessExecutor.status(result.handle)).state;
        return s === "completed" || s === "failed" || s === "not_found";
      },
      { timeout: 5000, message: "killed subprocess never exited" },
    );

    const statusAfter = await subprocessExecutor.status(result.handle);
    expect(["completed", "failed", "not_found"]).toContain(statusAfter.state);
  });

  it("rejects launch when agent has no command", async () => {
    const result = await subprocessExecutor.launch({
      sessionId: "s-nocmd",
      workdir: "/tmp",
      agent: {
        name: "no-command",
        model: "none",
        max_turns: 1,
        system_prompt: "",
        tools: [],
        skills: [],
        mcp_servers: [],
        permission_mode: "bypassPermissions",
        env: {},
      },
      task: "no command defined",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("command");
  });
});
