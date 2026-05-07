/**
 * Tests for channel-types.ts -- verify message type shapes compile and
 * have the expected required fields.
 */

import { describe, it, expect } from "bun:test";
import type {
  TaskAssignment,
  SteerMessage,
  AbortMessage,
  ProgressReport,
  CompletionReport,
  QuestionReport,
  ErrorReport,
  InboundMessage,
  OutboundMessage,
  ChannelMessage,
} from "../services/channel/channel-types.js";

describe("channel-types", () => {
  // ── Inbound messages (Conductor -> Agent) ──────────────────────────────

  describe("TaskAssignment", () => {
    it("has required fields: type, sessionId, stage, agent, task", () => {
      const msg: TaskAssignment = {
        type: "task",
        sessionId: "s-abc123",
        stage: "work",
        agent: "coder",
        task: "Build the feature",
      };
      expect(msg.type).toBe("task");
      expect(msg.sessionId).toBe("s-abc123");
      expect(msg.stage).toBe("work");
      expect(msg.agent).toBe("coder");
      expect(msg.task).toBe("Build the feature");
    });

    it("supports optional handoff field", () => {
      const msg: TaskAssignment = {
        type: "task",
        sessionId: "s-001",
        stage: "deploy",
        agent: "deployer",
        task: "Deploy to prod",
        handoff: {
          previousStages: [{ stage: "work", agent: "coder", summary: "Implemented feature" }],
          planMd: "# Plan\n- Step 1\n- Step 2",
          recentCommits: "abc1234 fix: thing\ndef5678 feat: other",
        },
      };
      expect(msg.handoff).toBeDefined();
      expect(msg.handoff!.previousStages.length).toBe(1);
      expect(msg.handoff!.planMd).toContain("Plan");
      expect(msg.handoff!.recentCommits).toContain("abc1234");
    });

    it("handoff previousStages entry can omit summary", () => {
      const msg: TaskAssignment = {
        type: "task",
        sessionId: "s-002",
        stage: "test",
        agent: "tester",
        task: "Run tests",
        handoff: {
          previousStages: [{ stage: "work", agent: "coder" }],
        },
      };
      expect(msg.handoff!.previousStages[0].summary).toBeUndefined();
    });
  });

  describe("SteerMessage", () => {
    it("has required fields: type, sessionId, message, from", () => {
      const msg: SteerMessage = {
        type: "steer",
        sessionId: "s-abc",
        message: "Focus on the tests",
        from: "conductor",
      };
      expect(msg.type).toBe("steer");
      expect(msg.sessionId).toBe("s-abc");
      expect(msg.message).toBe("Focus on the tests");
      expect(msg.from).toBe("conductor");
    });
  });

  describe("AbortMessage", () => {
    it("has required fields: type, sessionId, reason", () => {
      const msg: AbortMessage = {
        type: "abort",
        sessionId: "s-xyz",
        reason: "Timeout exceeded",
      };
      expect(msg.type).toBe("abort");
      expect(msg.sessionId).toBe("s-xyz");
      expect(msg.reason).toBe("Timeout exceeded");
    });
  });

  // ── Outbound messages (Agent -> Conductor) ─────────────────────────────

  describe("ProgressReport", () => {
    it("has required fields: type, sessionId, stage, message", () => {
      const msg: ProgressReport = {
        type: "progress",
        sessionId: "s-123",
        stage: "work",
        message: "Working on feature X",
      };
      expect(msg.type).toBe("progress");
      expect(msg.sessionId).toBe("s-123");
      expect(msg.stage).toBe("work");
      expect(msg.message).toBe("Working on feature X");
    });

    it("supports optional toolCalls and filesChanged", () => {
      const msg: ProgressReport = {
        type: "progress",
        sessionId: "s-123",
        stage: "work",
        message: "Progress",
        toolCalls: 15,
        filesChanged: ["src/index.ts", "src/utils.ts"],
      };
      expect(msg.toolCalls).toBe(15);
      expect(msg.filesChanged).toEqual(["src/index.ts", "src/utils.ts"]);
    });
  });

  describe("CompletionReport", () => {
    it("has required fields: type, sessionId, stage, summary, filesChanged, commits", () => {
      const msg: CompletionReport = {
        type: "completed",
        sessionId: "s-done",
        stage: "work",
        summary: "Feature implemented successfully",
        filesChanged: ["src/feature.ts"],
        commits: ["abc1234"],
      };
      expect(msg.type).toBe("completed");
      expect(msg.sessionId).toBe("s-done");
      expect(msg.stage).toBe("work");
      expect(msg.summary).toBe("Feature implemented successfully");
      expect(msg.filesChanged).toEqual(["src/feature.ts"]);
      expect(msg.commits).toEqual(["abc1234"]);
    });

    it("supports optional cost and turns", () => {
      const msg: CompletionReport = {
        type: "completed",
        sessionId: "s-done",
        stage: "work",
        summary: "Done",
        filesChanged: [],
        commits: [],
        cost: 0.45,
        turns: 12,
      };
      expect(msg.cost).toBe(0.45);
      expect(msg.turns).toBe(12);
    });
  });

  describe("QuestionReport", () => {
    it("has required fields: type, sessionId, stage, question", () => {
      const msg: QuestionReport = {
        type: "question",
        sessionId: "s-q",
        stage: "review",
        question: "Should I merge to main?",
      };
      expect(msg.type).toBe("question");
      expect(msg.sessionId).toBe("s-q");
      expect(msg.stage).toBe("review");
      expect(msg.question).toBe("Should I merge to main?");
    });

    it("supports optional options array", () => {
      const msg: QuestionReport = {
        type: "question",
        sessionId: "s-q",
        stage: "review",
        question: "Which approach?",
        options: ["Option A", "Option B", "Option C"],
      };
      expect(msg.options).toEqual(["Option A", "Option B", "Option C"]);
    });
  });

  describe("ErrorReport", () => {
    it("has required fields: type, sessionId, stage, error", () => {
      const msg: ErrorReport = {
        type: "error",
        sessionId: "s-err",
        stage: "deploy",
        error: "SSM connection refused",
      };
      expect(msg.type).toBe("error");
      expect(msg.sessionId).toBe("s-err");
      expect(msg.stage).toBe("deploy");
      expect(msg.error).toBe("SSM connection refused");
    });
  });

  // ── Union types ────────────────────────────────────────────────────────

  describe("InboundMessage union", () => {
    it("accepts TaskAssignment", () => {
      const msg: InboundMessage = {
        type: "task",
        sessionId: "s-1",
        stage: "work",
        agent: "coder",
        task: "Do it",
      };
      expect(msg.type).toBe("task");
    });

    it("accepts SteerMessage", () => {
      const msg: InboundMessage = {
        type: "steer",
        sessionId: "s-1",
        message: "Hurry up",
        from: "conductor",
      };
      expect(msg.type).toBe("steer");
    });

    it("accepts AbortMessage", () => {
      const msg: InboundMessage = {
        type: "abort",
        sessionId: "s-1",
        reason: "cancelled",
      };
      expect(msg.type).toBe("abort");
    });
  });

  describe("OutboundMessage union", () => {
    it("accepts ProgressReport", () => {
      const msg: OutboundMessage = {
        type: "progress",
        sessionId: "s-1",
        stage: "work",
        message: "Working",
      };
      expect(msg.type).toBe("progress");
    });

    it("accepts CompletionReport", () => {
      const msg: OutboundMessage = {
        type: "completed",
        sessionId: "s-1",
        stage: "work",
        summary: "Done",
        filesChanged: [],
        commits: [],
      };
      expect(msg.type).toBe("completed");
    });

    it("accepts QuestionReport", () => {
      const msg: OutboundMessage = {
        type: "question",
        sessionId: "s-1",
        stage: "work",
        question: "Help?",
      };
      expect(msg.type).toBe("question");
    });

    it("accepts ErrorReport", () => {
      const msg: OutboundMessage = {
        type: "error",
        sessionId: "s-1",
        stage: "work",
        error: "Boom",
      };
      expect(msg.type).toBe("error");
    });
  });

  describe("ChannelMessage union", () => {
    it("accepts all inbound message types", () => {
      const msgs: ChannelMessage[] = [
        { type: "task", sessionId: "s-1", stage: "w", agent: "c", task: "t" },
        { type: "steer", sessionId: "s-1", message: "m", from: "f" },
        { type: "abort", sessionId: "s-1", reason: "r" },
      ];
      expect(msgs.length).toBe(3);
    });

    it("accepts all outbound message types", () => {
      const msgs: ChannelMessage[] = [
        { type: "progress", sessionId: "s-1", stage: "w", message: "m" },
        { type: "completed", sessionId: "s-1", stage: "w", summary: "s", filesChanged: [], commits: [] },
        { type: "question", sessionId: "s-1", stage: "w", question: "q" },
        { type: "error", sessionId: "s-1", stage: "w", error: "e" },
      ];
      expect(msgs.length).toBe(4);
    });
  });
});
