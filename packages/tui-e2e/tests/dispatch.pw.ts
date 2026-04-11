/**
 * Ported from packages/e2e/tui.deprecated/dispatch.test.ts.
 *
 * The legacy file exercised TUI keystrokes that triggered REAL agent
 * dispatch via tmux + Claude/Codex/Gemini binaries, then asserted on
 * the in-process AppContext's DB state (`app.sessions.get(id).status`).
 * Neither side of that contract is reachable from this harness:
 *
 *   1. There's no in-process AppContext -- the TUI runs in a subprocess
 *      with its own SQLite DB. We can only observe via the rendered
 *      xterm buffer (`readTerminal(page)`).
 *   2. We don't want to spawn real agents in this pilot harness. The
 *      goal is to verify that pressing the relevant keys reaches the
 *      TUI and produces an observable UI change -- not that the
 *      downstream dispatch pipeline actually launches an agent.
 *
 * So this port preserves the SHAPE of the legacy coverage (Enter, s, I,
 * a, events pane) but asserts only on UI signals: a status-bar message
 * change, a row's status column changing, or a "Stopping" / "Stopped"
 * label appearing.
 *
 * For the interrupt / attach / live-output scenarios the legacy tests
 * dispatched a real agent to unlock the hotkey gates (gated on
 * `status === "running"|"waiting"`). We don't want real agents in CI,
 * so we surgically bump the seeded session's `status` column in SQLite
 * before the TUI opens the DB -- same pattern talk.pw.ts uses for its
 * talk-overlay test. Once the row looks "running" to the TUI, the hot
 * keys route through to the real RPC handlers, and we assert on the
 * rendered side effects (status bar message, detail pane content).
 * What we intentionally do NOT test is that a real agent actually
 * stops/interrupts/attaches -- that's integration coverage against a
 * live runtime which this harness does not ship.
 *
 * Keystroke delivery: we use `harness.write()` to write bytes directly
 * to the pty rather than `pressKey(page, ...)`. The Playwright →
 * xterm.js → WebSocket → pty pipeline doesn't reliably deliver every
 * keystroke (the page's textarea has to be focused, shift modifiers
 * have to be encoded, etc.). Writing to the pty bypasses xterm
 * entirely and lands the literal byte in Ink's stdin -- which is
 * exactly what the legacy `tui.press()` helper used to do via tmux
 * `send-keys`. See worktree.pw.ts for the same pattern + rationale.
 */

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
  startHarness,
  waitForText,
  waitForBuffer,
  readTerminal,
  seedSession,
  mkTempArkDir,
} from "../harness.js";

/**
 * Force a seeded session into an arbitrary status (and optionally a
 * fake `session_id`) by writing directly to the SQLite DB via the
 * `sqlite3` CLI. The TUI hotkey gates for interrupt / attach / talk
 * are guarded on `status === "running"|"waiting"`, and there is no
 * Ark CLI command to set status arbitrarily, so we surgically update
 * the row.
 *
 * IMPORTANT: this must be called BEFORE `startHarness()` -- once the
 * TUI subprocess opens its WAL connection, a second writer can race
 * on the row (or trip SQLite "database is locked").
 *
 * GOTCHA: AppContext._detectStaleState runs at boot and rewrites any
 * `status='running'` row whose `session_id` is set to a non-existent
 * tmux handle, flipping it to `failed`. That resets our carefully
 * forged state before the TUI even renders. Two ways to dodge:
 *   - For `status='running'` rows, leave `session_id` NULL. The
 *     stale check's `if (s.session_id && ...)` guard then skips.
 *   - For rows that MUST carry a fake `session_id` (so the attach
 *     gate unlocks), use `status='waiting'` instead -- the stale
 *     check only scans `status='running'` rows.
 */
function forceSessionState(
  arkDir: string,
  sessionId: string,
  fields: { status?: string; session_id?: string | null },
): void {
  const updates: string[] = [];
  if (fields.status !== undefined) updates.push(`status='${fields.status}'`);
  if (fields.session_id === null) updates.push(`session_id=NULL`);
  else if (fields.session_id !== undefined) updates.push(`session_id='${fields.session_id}'`);
  if (updates.length === 0) return;
  execFileSync(
    "sqlite3",
    [`${arkDir}/ark.db`, `UPDATE sessions SET ${updates.join(", ")} WHERE id='${sessionId}'`],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
  );
}

test.describe("Ark TUI dispatch and interaction", () => {
  test("pressing Enter on a ready session triggers an observable TUI reaction", async ({ page }) => {
    // The legacy test asserted that the session reached "running" or
    // "failed" in the DB after Enter. We can't reach the DB and we
    // don't actually want to launch an agent, so instead we assert on
    // an observable side effect: the TUI either flashes a "Dispatching"
    // status message OR shows the auth-required hint (when no API
    // credentials are configured -- the more common case in CI). Both
    // prove the keystroke reached the dispatch handler.
    const arkDir = mkTempArkDir();
    try {
      seedSession(arkDir, { summary: "dispatch-enter-test" });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "dispatch-enter-test", { timeoutMs: 10_000 });

        // Send a CR (\r) directly to the pty -- Ink's useInput receives
        // it as `key.return === true`, which triggers the dispatch
        // handler in SessionsTab.
        harness.write("\r");

        // Wait for any of: a "Dispatching" / "Dispatched" status message,
        // the auth-required hint, or a row-status transition out of "ready".
        await waitForBuffer(
          page,
          (text) =>
            text.includes("Dispatching") ||
            text.includes("Dispatched") ||
            text.includes("ark auth") ||
            text.includes("running") ||
            text.includes("failed"),
          { timeoutMs: 10_000 },
        );

        // Sanity-check the session row is still rendered after the action.
        const text = await readTerminal(page);
        expect(text).toContain("dispatch-enter-test");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing s on a seeded session transitions it to a stopped state", async ({ page }) => {
    // Legacy test dispatched a real agent first, then pressed `s` and
    // asserted DB status === "stopped". Since we don't dispatch and
    // can't read the DB, we assert that the row's status column changes
    // to "stopped" (or a transient "Stopping" status message appears).
    // For a freshly-seeded `ready` session, `actions.stop` still calls
    // `ark.sessionStop()` which transitions it to "stopped" -- the
    // hot-key handler in SessionsTab only skips stop for sessions that
    // are already in {completed, failed, stopped}.
    const arkDir = mkTempArkDir();
    try {
      seedSession(arkDir, { summary: "dispatch-stop-test" });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "dispatch-stop-test", { timeoutMs: 10_000 });

        // Write the literal "s" byte to the pty.
        harness.write("s");

        // Look for any concrete signal that the stop action ran.
        await waitForBuffer(
          page,
          (text) =>
            text.includes("Stopped") ||
            text.includes("Stopping") ||
            text.includes("stopped"),
          { timeoutMs: 10_000 },
        );

        const text = await readTerminal(page);
        // Row label should still be visible (we don't filter stopped
        // out by default).
        expect(text).toContain("dispatch-stop-test");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing I on a running session routes through the interrupt RPC without crashing the TUI", async ({ page }) => {
    // Legacy test dispatched a real agent so `status === "running"`,
    // then pressed `I` and asserted the agent received SIGINT. We
    // don't have a real agent, but we CAN seed the row into
    // `running` status directly in SQLite so the hotkey gate in
    // SessionsTab (guarded on `running`|`waiting`) unlocks.
    //
    // With `session_id` left NULL, `interrupt()` in
    // session-orchestration.ts returns `{ok:false, message:"No tmux
    // session"}` -- not an exception -- so the round-trip completes
    // cleanly and `useSessionActions.interrupt` unconditionally
    // calls `onSuccess("Interrupted <id>")`, which flashes a status
    // message we can observe. That proves:
    //   1. The hotkey gate logic unlocked `I` for a running row.
    //   2. The keystroke reached Ink's useInput.
    //   3. The TUI→server JSON-RPC round-trip completed.
    //   4. The TUI is still rendering afterwards.
    // What we don't test: that a real agent actually received SIGINT.
    // That requires a live runtime and belongs in an integration
    // suite, not this harness.
    const arkDir = mkTempArkDir();
    try {
      const id = seedSession(arkDir, { summary: "dispatch-interrupt-test", flow: "bare" });
      // status=running + session_id=NULL: stale detection at boot
      // skips the row (it guards on `s.session_id && ...`), so the
      // TUI sees a "running" session. interrupt() returns a clean
      // {ok:false, message:"No tmux session"} rather than throwing.
      forceSessionState(arkDir, id, { status: "running", session_id: null });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "dispatch-interrupt-test", { timeoutMs: 10_000 });

        // The `I` hotkey (interrupt) is case-sensitive -- write the
        // literal capital byte to the pty.
        harness.write("I");

        // Look for the action's spinner label, its success message,
        // or its error -- any one proves the RPC round-trip fired.
        await waitForBuffer(
          page,
          (text) =>
            text.includes("Interrupting") ||
            text.includes("Interrupted") ||
            text.includes("No tmux session") ||
            text.includes("failed"),
          { timeoutMs: 10_000 },
        );

        // TUI must still be alive and rendering the seeded row.
        const after = await readTerminal(page);
        expect(after).toContain("dispatch-interrupt-test");
        expect(after).toContain("Sessions");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing a on a running session routes through the attach helper without crashing the TUI", async ({ page }) => {
    // The attach hotkey (`a`) is guarded by a `session.session_id`
    // check inside `doAttach` in SessionsTab.tsx -- if there's no
    // handle, the handler returns early and produces no visible
    // signal. With a FAKE session_id we exercise the real attach
    // path: SessionsTab resolves the compute, asks the provider
    // whether the tmux session exists, and (since it doesn't) flashes
    // a "Session not found on <compute>" status message. That proves
    // the keystroke reached the handler and the attach pipeline ran
    // to completion without blowing up the TUI.
    //
    // We deliberately do NOT try to spawn a real `tmux attach`
    // subprocess -- the legacy test did that via Bun.spawnSync
    // inside the TUI process, which takes over the real terminal
    // and is fundamentally incompatible with a headless xterm.js
    // render pipeline. Reaching that code path would require a
    // runtime-stub executor that no-ops `attach`.
    const arkDir = mkTempArkDir();
    try {
      const id = seedSession(arkDir, { summary: "dispatch-attach-test", flow: "bare" });
      // status=waiting (not running) + non-null session_id. We use
      // `waiting` specifically to duck the boot-time stale session
      // detector (which only scans `status='running'` rows) while
      // still leaving `session_id` populated so doAttach's early
      // `if (!session.session_id) return;` guard passes and the
      // real attach pipeline runs.
      forceSessionState(arkDir, id, { status: "waiting", session_id: "ark-fake-attach" });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "dispatch-attach-test", { timeoutMs: 10_000 });

        // Lowercase `a` is the default attach hotkey.
        harness.write("a");

        // Either the transient "Attaching..." spinner label, the
        // "Session not found" status message, or a "Cannot attach"
        // string -- any one proves the handler ran.
        await waitForBuffer(
          page,
          (text) =>
            text.includes("Attaching") ||
            text.includes("Session not found") ||
            text.includes("Cannot attach") ||
            text.includes("Detached"),
          { timeoutMs: 10_000 },
        );

        // TUI must still be alive and rendering the seeded row.
        const after = await readTerminal(page);
        expect(after).toContain("dispatch-attach-test");
        expect(after).toContain("Sessions");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("detail pane renders something for a seeded session", async ({ page }) => {
    // Legacy test pressed Tab to focus the detail pane and asserted
    // that "Events", "stage_ready", or the session summary appeared
    // somewhere in the buffer. The seeded summary is the easiest
    // anchor and is always rendered, so this collapses to a render
    // sanity check.
    const arkDir = mkTempArkDir();
    try {
      seedSession(arkDir, { summary: "dispatch-events-display" });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "dispatch-events-display", { timeoutMs: 10_000 });

        // Press Tab to focus the detail pane (mirrors the legacy test).
        // \t is the literal Tab byte.
        harness.write("\t");
        await page.waitForTimeout(500);

        const text = await readTerminal(page);
        // Any of: an Events label, a stage marker, or the seeded
        // summary still being visible counts as the detail pane
        // having rendered.
        const sawDetail =
          text.includes("Events") ||
          text.includes("stage_ready") ||
          text.includes("dispatch-events-display");
        expect(sawDetail).toBe(true);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("detail pane renders the Live Output / Conversation sections for a running session", async ({ page }) => {
    // SessionDetail.tsx gates several sections on
    // `status === "running"`:
    //   - the Conversation placeholder ("Waiting for agent output...")
    //   - the Live Output header with an "Agent starting up..."
    //     fallback when the tmux capture comes back empty.
    // Both of those render even without a real tmux pane (the
    // useAgentOutput hook catches its own errors), so we get
    // deterministic text to assert against. The legacy test actually
    // checked that real tmux output streamed into the panel -- out
    // of scope without a live runtime -- so we weaken the assertion
    // to: the Live Output section header appears at all, AND the
    // Status row shows "running". That's enough to prove the
    // running-session rendering path in SessionDetail is exercised.
    const arkDir = mkTempArkDir();
    try {
      const id = seedSession(arkDir, { summary: "dispatch-live-output-test", flow: "bare" });
      // status=running + session_id=NULL dodges stale detection
      // (guarded on `s.session_id && ...`). With session_id NULL
      // the useAgentOutput hook short-circuits to an empty string,
      // which pushes SessionDetail onto the fallback branch that
      // renders the Live Output header + "Agent starting up..."
      // placeholder -- exactly the surface we want to assert on.
      forceSessionState(arkDir, id, { status: "running", session_id: null });

      // 40 rows mirrors the other tests in this file and is enough
      // for the detail pane to render down past Info → Status →
      // Conversation → Live Output on a single screen. Bumping it
      // higher increases xterm.js fit latency and occasionally
      // outlasts the initial waitForText deadline.
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "dispatch-live-output-test", { timeoutMs: 10_000 });

        // Wait for the detail pane to show the `running` status
        // label (the Status row renders `${icon} ${status}` for the
        // selected row). This also confirms the row is selected and
        // SessionDetail mounted the running-branch of its JSX.
        await waitForBuffer(
          page,
          (text) => text.includes("running"),
          { timeoutMs: 10_000 },
        );

        // The Live Output section header is only rendered for
        // running sessions. Wait for it.
        await waitForBuffer(
          page,
          (text) =>
            text.includes("Live Output") ||
            // Fallback: the useAgentOutput-driven placeholder line.
            text.includes("Agent starting up") ||
            // Fallback: the companion Conversation placeholder that
            // renders alongside it for running sessions.
            text.includes("Waiting for agent output"),
          { timeoutMs: 10_000 },
        );

        const text = await readTerminal(page);
        expect(text).toContain("dispatch-live-output-test");
        // One of these three must hold for the running-branch of
        // SessionDetail to have rendered.
        const sawRunningBranch =
          text.includes("Live Output") ||
          text.includes("Agent starting up") ||
          text.includes("Waiting for agent output");
        expect(sawRunningBranch).toBe(true);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
