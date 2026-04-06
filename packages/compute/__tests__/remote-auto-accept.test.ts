/**
 * Tests for remote autoAcceptChannelPrompt in EC2 remote-setup.
 * Verifies that the remote version sends "1" + Enter (not just Enter),
 * handles double-prompt from resume fallback, and uses correct working markers.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Mock SSH module before importing remote-setup ────────────────────────────

const sshCalls: { cmd: string }[] = [];
let sshResponses: { stdout: string; stderr: string; exitCode: number }[] = [];
let sshIndex = 0;

const mockSshExec = mock(async (_key: string, _ip: string, cmd: string, _opts?: any) => {
  sshCalls.push({ cmd });
  const response = sshResponses[sshIndex] ?? { stdout: "", stderr: "", exitCode: 0 };
  // Advance index for capture-pane calls only (not send-keys)
  if (cmd.includes("capture-pane")) {
    sshIndex = Math.min(sshIndex + 1, sshResponses.length - 1);
  }
  return response;
});

mock.module("../providers/ec2/ssh.js", () => ({
  sshExecAsync: mockSshExec,
  sshExec: mockSshExec,
  sshKeyPath: mock((name: string) => `/home/ubuntu/.ssh/ark-${name}`),
  sshBaseArgs: mock(() => ["ssh"]),
  SSH_OPTS: [],
  waitForSsh: mock(async () => true),
  waitForSshAsync: mock(async () => true),
  generateSshKey: mock(async () => ({ publicKeyPath: "", privateKeyPath: "" })),
  rsyncPush: mock(async () => {}),
  rsyncPull: mock(async () => {}),
  rsyncPushArgs: mock(() => []),
  rsyncPullArgs: mock(() => []),
}));

// Mock the sleep utility to be fast
mock.module("../util.js", () => ({
  sleep: mock(async (_ms: number) => {}),
  poll: mock(async () => true),
  retry: mock(async () => null),
}));

const { autoAcceptChannelPrompt } = await import("../providers/ec2/remote-setup.js");

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
  sshCalls.length = 0;
  sshResponses = [];
  sshIndex = 0;
  mockSshExec.mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("remote autoAcceptChannelPrompt", () => {
  it("sends '1' then Enter when prompt is detected", async () => {
    sshResponses = [ok(PROMPT_OUTPUT), ok(WORKING_OUTPUT)];

    await autoAcceptChannelPrompt("key", "1.2.3.4", "ark-test", { maxAttempts: 5, delayMs: 1 });

    const sendKeysCalls = sshCalls.filter(c => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(2);
    expect(sendKeysCalls[0].cmd).toContain("send-keys -t 'ark-test' 1");
    expect(sendKeysCalls[1].cmd).toContain("send-keys -t 'ark-test' Enter");
  });

  it("stops polling when Claude is working", async () => {
    sshResponses = [ok(WORKING_OUTPUT)];

    await autoAcceptChannelPrompt("key", "1.2.3.4", "ark-test", { maxAttempts: 5, delayMs: 1 });

    const sendKeysCalls = sshCalls.filter(c => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(0);
  });

  it("handles double prompt from resume fallback", async () => {
    sshResponses = [
      ok(PROMPT_OUTPUT),   // 1st prompt
      ok(STARTUP_OUTPUT),  // resume failing
      ok(PROMPT_OUTPUT),   // 2nd prompt
      ok(WORKING_OUTPUT),  // finally working
    ];

    await autoAcceptChannelPrompt("key", "1.2.3.4", "ark-test", { maxAttempts: 10, delayMs: 1 });

    const sendKeysCalls = sshCalls.filter(c => c.cmd.includes("send-keys"));
    // Should have sent keys for BOTH prompts: "1", Enter, "1", Enter
    const enterCalls = sendKeysCalls.filter(c => c.cmd.includes("Enter"));
    const oneCalls = sendKeysCalls.filter(c => c.cmd.endsWith(" 1"));
    expect(enterCalls.length).toBeGreaterThanOrEqual(2);
    expect(oneCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("detects prompt via 'local channel development' marker", async () => {
    const altPrompt = `
      --dangerously-load-development-channels is for local channel development
      only. Do not use downloaded channels.
    `;
    sshResponses = [ok(altPrompt), ok(WORKING_OUTPUT)];

    await autoAcceptChannelPrompt("key", "1.2.3.4", "ark-test", { maxAttempts: 5, delayMs: 1 });

    const sendKeysCalls = sshCalls.filter(c => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(2);
  });

  it("detects Claude working via 'esc to interrupt' marker", async () => {
    const working = `
      Claude is running
      esc to interrupt
    `;
    sshResponses = [ok(working)];

    await autoAcceptChannelPrompt("key", "1.2.3.4", "ark-test", { maxAttempts: 5, delayMs: 1 });

    const sendKeysCalls = sshCalls.filter(c => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(0);
  });

  it("does NOT match 'Welcome' or 'Claude Code v' as working indicators", async () => {
    // Previously the remote version used these as success indicators,
    // which could match before the channel prompt appeared
    const earlyOutput = `Welcome to Ubuntu\nClaude Code v1.2.3`;
    sshResponses = [
      ok(earlyOutput),     // should NOT stop polling here
      ok(PROMPT_OUTPUT),   // prompt appears
      ok(WORKING_OUTPUT),  // actually working
    ];

    await autoAcceptChannelPrompt("key", "1.2.3.4", "ark-test", { maxAttempts: 10, delayMs: 1 });

    // Should have continued past the "Welcome" output and accepted the prompt
    const sendKeysCalls = sshCalls.filter(c => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(2);
  });

  it("captures 30 lines of tmux output", async () => {
    sshResponses = [ok(WORKING_OUTPUT)];

    await autoAcceptChannelPrompt("key", "1.2.3.4", "ark-test", { maxAttempts: 3, delayMs: 1 });

    const captureCalls = sshCalls.filter(c => c.cmd.includes("capture-pane"));
    expect(captureCalls.length).toBeGreaterThan(0);
    expect(captureCalls[0].cmd).toContain("tail -30");
  });

  it("exhausts max attempts without error", async () => {
    sshResponses = [ok(STARTUP_OUTPUT)];

    await autoAcceptChannelPrompt("key", "1.2.3.4", "ark-test", { maxAttempts: 3, delayMs: 1 });

    const sendKeysCalls = sshCalls.filter(c => c.cmd.includes("send-keys"));
    expect(sendKeysCalls.length).toBe(0);
  });
});
