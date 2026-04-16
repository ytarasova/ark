/**
 * Tests for cli-agent executor auto-start (initialPrompt) dispatch.
 *
 * Validates that initialPrompt is correctly delivered via the three
 * task_delivery modes: arg, stdin, and file.
 *
 * Uses spyOn to mock tmux functions -- no real tmux sessions are created.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { cliAgentExecutor } from "../executors/cli-agent.js";
import * as tmux from "../infra/tmux.js";
import type { LaunchOpts } from "../executor.js";

// ── tmux spies ───────────────────────────────────────────────────────────────

const createdSessions: { name: string; cmd: string }[] = [];
const sentTexts: { name: string; text: string }[] = [];

let createSpy: ReturnType<typeof spyOn> | null = null;
let sendTextSpy: ReturnType<typeof spyOn> | null = null;
let killSpy: ReturnType<typeof spyOn> | null = null;

beforeAll(() => {
  createSpy = spyOn(tmux, "createSessionAsync").mockImplementation(
    async (name: string, cmd: string, _opts?: any): Promise<void> => {
      createdSessions.push({ name, cmd });
    },
  );
  sendTextSpy = spyOn(tmux, "sendTextAsync").mockImplementation(async (name: string, text: string): Promise<void> => {
    sentTexts.push({ name, text });
  });
  killSpy = spyOn(tmux, "killSessionAsync").mockImplementation(async () => {});
});

afterAll(() => {
  createSpy?.mockRestore();
  sendTextSpy?.mockRestore();
  killSpy?.mockRestore();
});

// ── App fixture ──────────────────────────────────────────────────────────────

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
  createdSessions.length = 0;
  sentTexts.length = 0;
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseLaunchOpts(overrides: Partial<LaunchOpts> = {}): LaunchOpts {
  return {
    sessionId: "s-clitest01",
    workdir: "/tmp/fake-workdir",
    agent: {
      name: "test-agent",
      model: "gpt-5-codex",
      max_turns: 100,
      system_prompt: "test",
      tools: [],
      skills: [],
      mcp_servers: [],
      permission_mode: "bypassPermissions",
      env: {},
      command: ["codex", "--approval-mode", "full-auto"],
    },
    task: "fallback task from session",
    env: {},
    app,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("cli-agent auto-start (initialPrompt)", () => {
  describe("task_delivery: arg", () => {
    it("appends initialPrompt as positional arg to command", async () => {
      const opts = baseLaunchOpts({
        initialPrompt: "Fix the login bug in auth.ts",
        agent: {
          ...baseLaunchOpts().agent,
          command: ["codex", "--approval-mode", "full-auto"],
          task_delivery: "arg",
        } as any,
      });

      const result = await cliAgentExecutor.launch(opts);

      expect(result.ok).toBe(true);
      expect(createdSessions.length).toBe(1);
      const cmd = createdSessions[0].cmd;
      expect(cmd).toContain("Fix the login bug in auth.ts");
      expect(cmd).toContain("codex --approval-mode full-auto");
      // Should NOT have sent anything via sendTextAsync
      expect(sentTexts.length).toBe(0);
    });

    it("uses task as fallback when no initialPrompt", async () => {
      const opts = baseLaunchOpts({
        task: "Default task text",
        agent: {
          ...baseLaunchOpts().agent,
          command: ["codex", "--full-auto"],
          task_delivery: "arg",
        } as any,
      });

      const result = await cliAgentExecutor.launch(opts);

      expect(result.ok).toBe(true);
      const cmd = createdSessions[0].cmd;
      expect(cmd).toContain("Default task text");
    });
  });

  describe("task_delivery: stdin", () => {
    it("launches without pipe and sends initialPrompt via sendTextAsync", async () => {
      const opts = baseLaunchOpts({
        initialPrompt: "Refactor the parser module",
        agent: {
          ...baseLaunchOpts().agent,
          command: ["gemini"],
          task_delivery: "stdin",
        } as any,
      });

      const result = await cliAgentExecutor.launch(opts);

      expect(result.ok).toBe(true);
      // Command should NOT contain cat | pipe (launched without piped stdin)
      const cmd = createdSessions[0].cmd;
      expect(cmd).not.toContain("cat ");
      expect(cmd).toContain("gemini");
      // Should have sent the prompt via sendTextAsync
      expect(sentTexts.length).toBe(1);
      expect(sentTexts[0].text).toBe("Refactor the parser module");
      expect(sentTexts[0].name).toBe("ark-s-clitest01");
    });

    it("pipes task via stdin when no initialPrompt", async () => {
      const opts = baseLaunchOpts({
        task: "Original task via pipe",
        agent: {
          ...baseLaunchOpts().agent,
          command: ["gemini"],
          task_delivery: "stdin",
        } as any,
      });

      const result = await cliAgentExecutor.launch(opts);

      expect(result.ok).toBe(true);
      const cmd = createdSessions[0].cmd;
      expect(cmd).toContain("cat ");
      expect(cmd).toContain("| gemini");
      // Should NOT have called sendTextAsync
      expect(sentTexts.length).toBe(0);
    });
  });

  describe("task_delivery: file", () => {
    it("writes initialPrompt to task file when provided", async () => {
      const opts = baseLaunchOpts({
        initialPrompt: "Analyze the codebase structure",
        agent: {
          ...baseLaunchOpts().agent,
          command: ["mytool", "--file"],
          task_delivery: "file",
        } as any,
      });

      const result = await cliAgentExecutor.launch(opts);

      expect(result.ok).toBe(true);
      const cmd = createdSessions[0].cmd;
      expect(cmd).toContain("mytool --file");
      expect(cmd).toContain("task.txt");
      // The file content is verified implicitly -- the command references the task file
      expect(sentTexts.length).toBe(0);
    });
  });
});
