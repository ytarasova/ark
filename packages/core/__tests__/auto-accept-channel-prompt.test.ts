/**
 * Tests for autoAcceptChannelPrompt — verifies that the channel development
 * prompt is properly detected and accepted, including the resume-fallback
 * scenario where the prompt appears twice.
 *
 * Uses spyOn instead of mock.module to avoid poisoning the tmux module
 * for other test files in the same bun test run.
 */

import { describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test";
import * as tmux from "../tmux.js";
import { autoAcceptChannelPrompt } from "../claude.js";

// ── Spy setup ──────────────────────────────────────────────────────────────

let captureResponses: string[] = [];
let captureIndex = 0;
const sentKeys: string[][] = [];

const captureSpy = spyOn(tmux, "capturePaneAsync").mockImplementation(
  async (_name: string, _opts?: any) => {
    const response = captureResponses[captureIndex] ?? "";
    captureIndex = Math.min(captureIndex + 1, captureResponses.length - 1);
    return response;
  }
);

const sendKeysSpy = spyOn(tmux, "sendKeysAsync").mockImplementation(
  async (_name: string, ...keys: string[]) => {
    sentKeys.push(keys);
  }
);

// ── Restore after all tests ────────────────────────────────────────────────

afterAll(() => {
  captureSpy.mockRestore();
  sendKeysSpy.mockRestore();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROMPT_OUTPUT = `
  WARNING: Loading development channels
  --dangerously-load-development-channels is for local channel development
  only. Do not use this option to run channels you have downloaded off the
  internet.
  Please use --channels to run a list of approved channels.
  Channels: server:ark-channel
  ❯ 1. I am using this for local development
    2. Exit
  Enter to confirm · Esc to cancel
`;

const WORKING_OUTPUT = `
  Claude Code v1.2.3

  > Working on some task
  ctrl+o to expand
`;

const STARTUP_OUTPUT = `
  No conversation found with session ID: abc-123
  Starting new session...
`;

beforeEach(() => {
  captureResponses = [];
  captureIndex = 0;
  sentKeys.length = 0;
  captureSpy.mockClear();
  sendKeysSpy.mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("autoAcceptChannelPrompt", () => {
  it("sends '1' + Enter when prompt is detected", async () => {
    captureResponses = [PROMPT_OUTPUT, WORKING_OUTPUT];

    await autoAcceptChannelPrompt("ark-test", { maxAttempts: 5, delayMs: 1 });

    // Should have sent "1" then "Enter"
    expect(sentKeys).toEqual([["1"], ["Enter"]]);
  });

  it("stops polling when Claude is working (no prompt)", async () => {
    captureResponses = [WORKING_OUTPUT];

    await autoAcceptChannelPrompt("ark-test", { maxAttempts: 5, delayMs: 1 });

    // Should not have sent any keys
    expect(sentKeys).toEqual([]);
  });

  it("keeps polling during startup before prompt appears", async () => {
    captureResponses = [
      STARTUP_OUTPUT,  // startup - no prompt yet
      STARTUP_OUTPUT,  // still starting
      PROMPT_OUTPUT,   // prompt appears
      WORKING_OUTPUT,  // Claude starts working
    ];

    await autoAcceptChannelPrompt("ark-test", { maxAttempts: 10, delayMs: 1 });

    // Should have sent "1" + Enter when prompt was found on 3rd poll
    expect(sentKeys).toEqual([["1"], ["Enter"]]);
  });

  it("handles double prompt from resume fallback", async () => {
    // Scenario: --resume fails, first prompt accepted, then second prompt appears
    captureResponses = [
      PROMPT_OUTPUT,   // 1st prompt (from --resume attempt)
      PROMPT_OUTPUT,   // prompt still showing (keys in flight)
      STARTUP_OUTPUT,  // resume fails, transitioning to --session-id
      PROMPT_OUTPUT,   // 2nd prompt (from --session-id attempt)
      WORKING_OUTPUT,  // finally working
    ];

    await autoAcceptChannelPrompt("ark-test", { maxAttempts: 10, delayMs: 1 });

    // Should have accepted the prompt TWICE (4 keys total: "1", Enter, "1", Enter)
    const enterCount = sentKeys.filter(k => k[0] === "Enter").length;
    const oneCount = sentKeys.filter(k => k[0] === "1").length;
    expect(enterCount).toBeGreaterThanOrEqual(2);
    expect(oneCount).toBeGreaterThanOrEqual(2);
  });

  it("exhausts max attempts without error when prompt never appears", async () => {
    captureResponses = [STARTUP_OUTPUT]; // never shows prompt or working

    // Should not throw
    await autoAcceptChannelPrompt("ark-test", { maxAttempts: 3, delayMs: 1 });

    expect(sentKeys).toEqual([]);
  });

  it("detects prompt via 'local channel development' marker", async () => {
    const altPrompt = `
      --dangerously-load-development-channels is for local channel development
      only. Do not use downloaded channels.
    `;
    captureResponses = [altPrompt, WORKING_OUTPUT];

    await autoAcceptChannelPrompt("ark-test", { maxAttempts: 5, delayMs: 1 });

    expect(sentKeys).toEqual([["1"], ["Enter"]]);
  });

  it("detects Claude working via 'esc to interrupt' marker", async () => {
    const workingAlt = `
      Claude is doing things
      esc to interrupt
    `;
    captureResponses = [workingAlt];

    await autoAcceptChannelPrompt("ark-test", { maxAttempts: 5, delayMs: 1 });

    expect(sentKeys).toEqual([]);
  });
});
