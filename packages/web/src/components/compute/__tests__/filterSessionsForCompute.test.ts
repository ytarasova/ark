/**
 * Tests for the `filterSessionsForCompute` helper that powers the
 * "Sessions on this Compute" table in ComputeDetailPanel.
 *
 * The filter's job is to answer "which live worker processes belong to
 * the compute row the user is viewing?" -- a question that's subtly
 * wrong in a few ways if you filter naively on compute_name, so we pin
 * each rule with its own test.
 */

import { describe, test, expect } from "bun:test";
import { filterSessionsForCompute } from "../helpers.js";

function session(overrides: Record<string, unknown> = {}): any {
  return {
    id: "s-default",
    session_id: "ark-s-default",
    compute_name: null,
    status: "running",
    ...overrides,
  };
}

describe("filterSessionsForCompute", () => {
  test("keeps sessions whose compute_name matches", () => {
    const out = filterSessionsForCompute([session({ id: "s-a", compute_name: "my-ec2" })], "my-ec2");
    expect(out.map((s: any) => s.id)).toEqual(["s-a"]);
  });

  test("drops sessions whose compute_name points at a different compute", () => {
    const out = filterSessionsForCompute([session({ id: "s-a", compute_name: "other-ec2" })], "my-ec2");
    expect(out).toEqual([]);
  });

  test("drops unattached (compute_name=null) sessions on non-local compute panels", () => {
    // This is the main bug. Previously, a session running on the implicit
    // local host (compute_name=null) appeared in EVERY compute detail
    // panel, so the EC2 panel claimed to be running the user's local
    // session. Non-local panels must NOT adopt unattached sessions.
    const out = filterSessionsForCompute([session({ id: "s-unattached", compute_name: null })], "my-ec2");
    expect(out).toEqual([]);
  });

  test("keeps unattached (compute_name=null) sessions on the local compute panel", () => {
    // The server-side gap: the dispatcher leaves compute_name=null for
    // sessions that resolve against the seeded `local` row. The local
    // panel is the correct (and only) home for those rows until the
    // server backfills compute_name="local" explicitly.
    const out = filterSessionsForCompute([session({ id: "s-unattached", compute_name: null })], "local");
    expect(out.map((s: any) => s.id)).toEqual(["s-unattached"]);
  });

  test("drops sessions in terminal status even when compute_name matches", () => {
    const terminal = ["completed", "failed", "stopped", "archived", "killed"];
    for (const status of terminal) {
      const out = filterSessionsForCompute([session({ id: `s-${status}`, compute_name: "my-ec2", status })], "my-ec2");
      expect(out).toEqual([]);
    }
  });

  test("drops rows with no session_id (dispatch never attached a worker)", () => {
    // These are the stale / dispatch_failed rows that used to render as
    // empty cells in the Session column. Requiring session_id is the
    // durable "this is a real live worker" test.
    const out = filterSessionsForCompute(
      [session({ id: "s-orphan", compute_name: "my-ec2", session_id: null })],
      "my-ec2",
    );
    expect(out).toEqual([]);
  });

  test("combined: only returns rows that satisfy all three rules", () => {
    const sessions = [
      session({ id: "keep-1", compute_name: "my-ec2" }),
      session({ id: "keep-2", compute_name: null }), // null -> only if computeName=local
      session({ id: "drop-wrong-compute", compute_name: "other" }),
      session({ id: "drop-terminal", compute_name: "my-ec2", status: "completed" }),
      session({ id: "drop-no-handle", compute_name: "my-ec2", session_id: null }),
    ];
    expect(filterSessionsForCompute(sessions, "my-ec2").map((s: any) => s.id)).toEqual(["keep-1"]);
    expect(filterSessionsForCompute(sessions, "local").map((s: any) => s.id)).toEqual(["keep-2"]);
  });
});
