/**
 * resolveDisplayStatus: header pill heuristic that upgrades stale
 * `pending` / `waiting` / `stopped` rows to `running` when the event
 * stream shows live activity within the last 60s.
 *
 * Terminal states (completed/failed) are write-once and must never be
 * upgraded -- a recent event after a session failed is normal (cleanup
 * hooks fire after markDispatchFailedShared) and must not flip the pill.
 */

import { describe, it, expect } from "bun:test";
import { resolveDisplayStatus } from "../display-status.js";
import { normalizeStatus } from "../timeline-builder.js";

const now = () => new Date().toISOString();
const minutesAgo = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

describe("resolveDisplayStatus", () => {
  it("returns running when DB status is running, regardless of events", () => {
    expect(resolveDisplayStatus({ status: "running" }, [], normalizeStatus)).toBe("running");
  });

  it("returns completed when DB status is completed (not subject to live override)", () => {
    expect(resolveDisplayStatus({ status: "completed" }, [{ created_at: now() }], normalizeStatus)).toBe("completed");
  });

  it("returns failed when DB status is failed (not subject to live override)", () => {
    expect(resolveDisplayStatus({ status: "failed" }, [{ created_at: now() }], normalizeStatus)).toBe("failed");
  });

  it("upgrades pending -> running when there's an event in the last 60s", () => {
    // session.status === "ready" normalizes to "pending"; agent is clearly
    // active because events are flowing -- the user should see "running".
    expect(resolveDisplayStatus({ status: "ready" }, [{ created_at: now() }], normalizeStatus)).toBe("running");
  });

  it("does NOT upgrade pending when the latest event is older than 60s", () => {
    expect(resolveDisplayStatus({ status: "ready" }, [{ created_at: minutesAgo(5) }], normalizeStatus)).toBe("pending");
  });

  it("ignores invalid/missing event timestamps", () => {
    expect(
      resolveDisplayStatus({ status: "ready" }, [{ created_at: "" }, { created_at: undefined }], normalizeStatus),
    ).toBe("pending");
  });

  it("upgrades waiting -> running on live activity", () => {
    expect(resolveDisplayStatus({ status: "waiting" }, [{ created_at: now() }], normalizeStatus)).toBe("running");
  });

  it("does not upgrade stopped on live activity (manual kill must stick)", () => {
    // stopped is a deliberate user kill -- if the agent keeps emitting
    // events afterwards (SIGTERM racing with hooks) the row must stay
    // "stopped" rather than flip back to "running".
    expect(resolveDisplayStatus({ status: "stopped" }, [{ created_at: now() }], normalizeStatus)).toBe("stopped");
  });
});
