/**
 * Tests for useAuthStatus — checks env vars and file existence for auth status.
 * Uses React rendering pattern to test the hook via a capture component.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useAuthStatus } from "../hooks/useAuthStatus.js";
import { registerProvider, clearProviders } from "../../compute/index.js";
import { AppContext, setApp, clearApp, type Compute } from "../../core/index.js";
import { withTestContext } from "../../core/__tests__/test-helpers.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

withTestContext();

let capturedStatus: { hasAuth: boolean; authType: string | null } | null = null;

function AuthCapture({ compute }: { compute: Compute | undefined | null }) {
  const status = useAuthStatus(compute);
  capturedStatus = status;
  return <Text>{`auth=${status.hasAuth} type=${status.authType ?? "null"}`}</Text>;
}

function mockCompute(overrides?: Partial<Compute>): Compute {
  return {
    name: "test-remote",
    provider: "mock-remote",
    status: "running",
    config: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Compute;
}

function mockRemoteProvider(name = "mock-remote") {
  return {
    name,
    isolationModes: [],
    canReboot: false,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "running",
    needsAuth: true,
    provision: async () => {},
    destroy: async () => {},
    start: async () => {},
    stop: async () => {},
    launch: async () => "",
    attach: async () => {},
    killAgent: async () => {},
    captureOutput: async () => "",
    cleanupSession: async () => {},
    getMetrics: async () => ({
      metrics: { cpu: 0, memUsedGb: 0, memTotalGb: 0, memPct: 0, diskPct: 0, netRxMb: 0, netTxMb: 0, uptime: "0s", idleTicks: 0 },
      sessions: [], processes: [], docker: [],
    }),
    probePorts: async () => [],
    syncEnvironment: async () => {},
    checkSession: async () => false,
    getAttachCommand: () => [],
    buildChannelConfig: () => ({}),
    buildLaunchEnv: () => ({}),
  };
}

function mockLocalProvider(name = "mock-local") {
  return {
    ...mockRemoteProvider(name),
    name,
    needsAuth: false,
  };
}

// Save and restore env vars
const savedEnv: Record<string, string | undefined> = {};
const authEnvVars = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
];

let app: AppContext;

beforeEach(async () => {
  capturedStatus = null;
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
  for (const key of authEnvVars) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  clearProviders();
});

afterEach(() => {
  for (const key of authEnvVars) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
  clearProviders();
});

afterAll(async () => {
  if (app) await app.shutdown();
  clearApp();
  clearProviders();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useAuthStatus", () => {
  it("returns hasAuth: true when compute is undefined (local)", () => {
    const { unmount } = render(<AuthCapture compute={undefined} />);
    expect(capturedStatus).not.toBeNull();
    expect(capturedStatus!.hasAuth).toBe(true);
    expect(capturedStatus!.authType).toBeNull();
    unmount();
  });

  it("returns hasAuth: true when compute is null", () => {
    const { unmount } = render(<AuthCapture compute={null} />);
    expect(capturedStatus!.hasAuth).toBe(true);
    expect(capturedStatus!.authType).toBeNull();
    unmount();
  });

  it("returns hasAuth: true when provider does not need auth", () => {
    registerProvider(mockLocalProvider());
    const compute = mockCompute({ provider: "mock-local" });
    const { unmount } = render(<AuthCapture compute={compute} />);
    expect(capturedStatus!.hasAuth).toBe(true);
    expect(capturedStatus!.authType).toBeNull();
    unmount();
  });

  it("returns hasAuth: true with authType api_key_env when ANTHROPIC_API_KEY is set", () => {
    registerProvider(mockRemoteProvider());
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    const compute = mockCompute();
    const { unmount } = render(<AuthCapture compute={compute} />);
    expect(capturedStatus!.hasAuth).toBe(true);
    expect(capturedStatus!.authType).toBe("api_key_env");
    unmount();
  });

  it("returns hasAuth: true with authType oauth_env when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    registerProvider(mockRemoteProvider());
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test-token";
    const compute = mockCompute();
    const { unmount } = render(<AuthCapture compute={compute} />);
    expect(capturedStatus!.hasAuth).toBe(true);
    expect(capturedStatus!.authType).toBe("oauth_env");
    unmount();
  });

  it("returns hasAuth: true with authType session_env when CLAUDE_CODE_SESSION_ACCESS_TOKEN is set", () => {
    registerProvider(mockRemoteProvider());
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = "session-test-token";
    const compute = mockCompute();
    const { unmount } = render(<AuthCapture compute={compute} />);
    expect(capturedStatus!.hasAuth).toBe(true);
    expect(capturedStatus!.authType).toBe("session_env");
    unmount();
  });

  it("oauth_env takes precedence over api_key_env", () => {
    registerProvider(mockRemoteProvider());
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
    process.env.ANTHROPIC_API_KEY = "api-key";
    const compute = mockCompute();
    const { unmount } = render(<AuthCapture compute={compute} />);
    expect(capturedStatus!.authType).toBe("oauth_env");
    unmount();
  });

  it("returns hasAuth: false when no auth env vars are set for remote provider", () => {
    registerProvider(mockRemoteProvider());
    // Point HOME to a temp dir so the saved-token file check doesn't find anything
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/ark-auth-test-nonexistent";
    try {
      const compute = mockCompute();
      const { unmount } = render(<AuthCapture compute={compute} />);
      expect(capturedStatus!.hasAuth).toBe(false);
      expect(capturedStatus!.authType).toBeNull();
      unmount();
    } finally {
      process.env.HOME = originalHome;
    }
  });
});
