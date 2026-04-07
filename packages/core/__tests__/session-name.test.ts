/**
 * Tests for session name sanitization logic.
 * The sanitize function is extracted from NewSessionForm.tsx submit handler.
 *
 * Also includes E2E tests verifying that the core layer stores names as-is
 * (sanitization happens at the form/CLI level, not in core).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { startSession } from "../index.js";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

/** Same sanitization regex as in NewSessionForm.tsx submit */
const sanitize = (name: string) =>
  name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

withTestContext();

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

describe("session name sanitization", () => {
  it("replaces spaces with dashes", () => {
    expect(sanitize("hello world")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(sanitize("test@#$session")).toBe("test-session");
  });

  it("collapses multiple dashes into one", () => {
    expect(sanitize("a--b---c")).toBe("a-b-c");
  });

  it("strips leading and trailing dashes", () => {
    expect(sanitize("-test-")).toBe("test");
  });

  it("truncates to 60 characters", () => {
    const long = "a".repeat(100);
    const result = sanitize(long);
    expect(result.length).toBe(60);
  });

  it("passes through already clean names", () => {
    expect(sanitize("my-session")).toBe("my-session");
    expect(sanitize("my_session_123")).toBe("my_session_123");
  });

  it("handles mixed special characters", () => {
    expect(sanitize("hello world!@#$%^&*()")).toBe("hello-world");
  });

  it("preserves underscores", () => {
    expect(sanitize("snake_case_name")).toBe("snake_case_name");
  });

  it("handles consecutive special chars as single dash", () => {
    expect(sanitize("a!!!b")).toBe("a-b");
  });
});

// ── E2E: core stores names as-is ─────────────────────────────────────────────

describe("session name in core (E2E)", () => {
  it("stores name with spaces as-is in the DB", () => {
    const session = startSession({
      summary: "my test session",
      flow: "bare",
    });

    const stored = getApp().sessions.get(session.id)!;
    expect(stored.summary).toBe("my test session");
  });

  it("stores name with special characters as-is in the DB", () => {
    const session = startSession({
      summary: "fix: auth module (v2)",
      flow: "bare",
    });

    const stored = getApp().sessions.get(session.id)!;
    expect(stored.summary).toBe("fix: auth module (v2)");
  });

  it("stores empty summary as null", () => {
    const session = startSession({ flow: "bare" });

    const stored = getApp().sessions.get(session.id)!;
    expect(stored.summary).toBeNull();
  });

  it("stores long names without truncation in core", () => {
    const longName = "a".repeat(200);
    const session = startSession({
      summary: longName,
      flow: "bare",
    });

    const stored = getApp().sessions.get(session.id)!;
    expect(stored.summary).toBe(longName);
    expect(stored.summary!.length).toBe(200);
  });
});
