/**
 * assembleTask event-emission tests.
 *
 * Guards the #417 contract that prompt_sent events never carry the full
 * prompt text (task_full). The full prompt is already persisted on the
 * session row + input store; duplicating it into every event row bloats
 * the events table and wrecks the timeline drawer (5-10KB JSON blob per
 * stage). We also verify task_preview is truncated and task_length is
 * the unprefixed length of the final prompt.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppContext } from "../../../app.js";
import { assembleTask } from "../task-assembly.js";
import type { Session } from "../../../../types/index.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

function deps(events: AppContext["events"], prompt: string) {
  return {
    buildTask: async () => prompt,
    indexRepo: async () => undefined,
    injectKnowledge: async (_s: Session, t: string) => t,
    injectRepoMap: (_s: Session, t: string) => t,
    events,
  };
}

describe("assembleTask -- prompt_sent event shape (#417)", () => {
  test("does NOT emit task_full in the event payload", async () => {
    const s = await app.sessions.create({ summary: "issue-417 emit" });
    const fullPrompt = "A".repeat(8000) + "\nline 2\nline 3";
    await assembleTask(deps(app.events, fullPrompt), s as Session, "implement", "implementer", () => {});

    const events = await app.events.list(s.id);
    const emitted = events.find((e: { type: string }) => e.type === "prompt_sent");
    expect(emitted).toBeTruthy();
    const data = (emitted as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("task_full");
    // Keep the audit fields the UI relies on.
    expect(data.agent).toBe("implementer");
    expect(typeof data.task_preview).toBe("string");
    expect((data.task_preview as string).length).toBeLessThanOrEqual(500);
    expect(data.task_length).toBe(fullPrompt.length);
  });

  test("task_preview is a clean slice of the final prompt -- no \\n escapes", async () => {
    const s = await app.sessions.create({ summary: "issue-417 preview" });
    const fullPrompt = "stage: implement\nfiles:\n  - a.ts\n  - b.ts\n\nbody text";
    await assembleTask(deps(app.events, fullPrompt), s as Session, "implement", "implementer", () => {});

    const events = await app.events.list(s.id);
    const emitted = events.find((e: { type: string }) => e.type === "prompt_sent");
    const preview = (emitted as { data: Record<string, unknown> }).data.task_preview as string;
    // Real newlines preserved -- the UI <pre> will render them as line breaks.
    expect(preview).toContain("\n");
    // Never the literal two chars \ and n.
    expect(preview.includes("\\n")).toBe(false);
  });
});
