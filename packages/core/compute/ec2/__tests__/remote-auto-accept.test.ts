/**
 * Tests for remote autoAcceptChannelPrompt in EC2 remote-setup.
 * Verifies that the remote version sends "1" + Enter (not just Enter),
 * handles double-prompt from resume fallback, and uses correct working markers.
 *
 * Uses spyOn rather than mock.module so the SSM module isn't poisoned for
 * other test files in the same `bun test` invocation (notably ec2-ssm.test.ts).
 */

import { describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test";
import * as ssmModule from "../ssm.js";
import * as utilModule from "../retry.js";

// ── Spy setup ────────────────────────────────────────────────────────────────

const ssmCalls: { cmd: string }[] = [];
let ssmResponses: { stdout: string; stderr: string; exitCode: number }[] = [];
let ssmIndex = 0;

const ssmExecSpy = spyOn(ssmModule, "ssmExec").mockImplementation(
  async (opts: { instanceId: string; command: string; [k: string]: unknown }) => {
    ssmCalls.push({ cmd: opts.command });
    const response = ssmResponses[ssmIndex] ?? { stdout: "", stderr: "", exitCode: 0 };
    if (opts.command.includes("capture-pane")) {
      ssmIndex = Math.min(ssmIndex + 1, ssmResponses.length - 1);
    }
    return response;
  },
);

const sleepSpy = spyOn(utilModule, "sleep").mockImplementation(async () => {});

afterAll(() => {
  ssmExecSpy.mockRestore();
  sleepSpy.mockRestore();
});

const { autoAcceptChannelPrompt } = await import("../remote-setup.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });

const PROMPT_OUTPUT = `
  WARNING: Loading development channels
  Channels: server:ark-channel
  ❯ 1. I am using this for local development
    2. Exit
  Enter to confirm · Esc to cancel
`;

const WORKING_OUTPUT = `
  Claude Code v1.2.3
  > Working on task
  ctrl+o to expand
`;

const STARTUP_OUTPUT = `
  No conversation found with session ID: abc-123
`;

beforeEach(() => {
  ssmCalls.length = 0;
  ssmResponses = [];
  ssmIndex = 0;
  ssmExecSpy.mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("remote autoAcceptChannelPrompt", async () => {
  it("sends '1' then Enter when prompt is detected", async () => {
    ssmResponses = [ok(PROMPT_OUTPUT), ok(WORKING_OUTPUT)];

    await autoAcceptChannelPrompt("i-test", { region: "us-east-1" }, "ark-test", { maxAttempts: 5, delayMs: 1 });

    const sendKeysCalls = ssmCalls.filter((c) => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(2);
    expect(sendKeysCalls[0].cmd).toContain("send-keys -t 'ark-test' 1");
    expect(sendKeysCalls[1].cmd).toContain("send-keys -t 'ark-test' Enter");
  });

  it("stops polling when Claude is working", async () => {
    ssmResponses = [ok(WORKING_OUTPUT)];

    await autoAcceptChannelPrompt("i-test", { region: "us-east-1" }, "ark-test", { maxAttempts: 5, delayMs: 1 });

    const sendKeysCalls = ssmCalls.filter((c) => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(0);
  });

  it("handles double prompt from resume fallback", async () => {
    ssmResponses = [
      ok(PROMPT_OUTPUT), // 1st prompt
      ok(STARTUP_OUTPUT), // resume failing
      ok(PROMPT_OUTPUT), // 2nd prompt
      ok(WORKING_OUTPUT), // finally working
    ];

    await autoAcceptChannelPrompt("i-test", { region: "us-east-1" }, "ark-test", {
      maxAttempts: 10,
      delayMs: 1,
    });

    const sendKeysCalls = ssmCalls.filter((c) => c.cmd.includes("send-keys"));
    const enterCalls = sendKeysCalls.filter((c) => c.cmd.includes("Enter"));
    const oneCalls = sendKeysCalls.filter((c) => c.cmd.endsWith(" 1"));
    expect(enterCalls.length).toBeGreaterThanOrEqual(2);
    expect(oneCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("detects prompt via 'local channel development' marker", async () => {
    const altPrompt = `
      --dangerously-load-development-channels is for local channel development
      only. Do not use downloaded channels.
    `;
    ssmResponses = [ok(altPrompt), ok(WORKING_OUTPUT)];

    await autoAcceptChannelPrompt("i-test", { region: "us-east-1" }, "ark-test", { maxAttempts: 5, delayMs: 1 });

    const sendKeysCalls = ssmCalls.filter((c) => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(2);
  });

  it("detects Claude working via 'esc to interrupt' marker", async () => {
    const working = `
      Claude is running
      esc to interrupt
    `;
    ssmResponses = [ok(working)];

    await autoAcceptChannelPrompt("i-test", { region: "us-east-1" }, "ark-test", { maxAttempts: 5, delayMs: 1 });

    const sendKeysCalls = ssmCalls.filter((c) => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(0);
  });

  it("does NOT match 'Welcome' or 'Claude Code v' as working indicators", async () => {
    const earlyOutput = `Welcome to Ubuntu\nClaude Code v1.2.3`;
    ssmResponses = [ok(earlyOutput), ok(PROMPT_OUTPUT), ok(WORKING_OUTPUT)];

    await autoAcceptChannelPrompt("i-test", { region: "us-east-1" }, "ark-test", {
      maxAttempts: 10,
      delayMs: 1,
    });

    const sendKeysCalls = ssmCalls.filter((c) => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(2);
  });

  it("captures 30 lines of tmux output", async () => {
    ssmResponses = [ok(WORKING_OUTPUT)];

    await autoAcceptChannelPrompt("i-test", { region: "us-east-1" }, "ark-test", { maxAttempts: 3, delayMs: 1 });

    const captureCalls = ssmCalls.filter((c) => c.cmd.includes("capture-pane"));
    expect(captureCalls.length).toBeGreaterThan(0);
    expect(captureCalls[0].cmd).toContain("tail -30");
  });

  it("exhausts max attempts without error", async () => {
    ssmResponses = [ok(STARTUP_OUTPUT)];

    await autoAcceptChannelPrompt("i-test", { region: "us-east-1" }, "ark-test", { maxAttempts: 3, delayMs: 1 });

    const sendKeysCalls = ssmCalls.filter((c) => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(0);
  });
});
