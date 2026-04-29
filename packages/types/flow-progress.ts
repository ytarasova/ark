import type { Session } from "./session.js";
import type { FlowDefinition } from "./flow.js";

/**
 * One segment of a session's progress strip.
 *
 * The `state` field is the canonical visual classification the UI uses to
 * pick a colour:
 *  - `done`     finished successfully
 *  - `active`   currently in flight (running / waiting / mid-iteration)
 *  - `pending`  not yet started
 *  - `failed`   reached this point and failed; remaining segments stay pending
 *  - `skipped`  the flow's conditional routing routed around this segment
 */
export type FlowSegmentState = "done" | "active" | "pending" | "failed" | "skipped";

export interface FlowSegment {
  /** Stable label. Stage name for `kind: "stages"`, child session id /
   *  iteration index for `kind: "iterations"`. */
  name: string;
  state: FlowSegmentState;
  /** When `kind: "iterations"`, the child session id. Stable across reorder
   *  so React keys + tooltips can deep-link. */
  sessionId?: string;
}

export type FlowProgressKind = "iterations" | "stages";

export interface FlowProgress {
  kind: FlowProgressKind;
  segments: FlowSegment[];
}

/**
 * Pure projection from authoritative state to a `FlowProgress` value.
 *
 * Two shapes are emitted:
 *  - **iterations** -- when the session is a `for_each` parent and we have
 *    its children loaded. Each child session becomes one segment, ordered
 *    by `config.for_each_index`. Status is mapped to `FlowSegmentState`.
 *    Total segments = max(children.length, expected total). When the loop
 *    is mid-flight, slots past the highest known index render as `pending`
 *    so the strip keeps width parity with the eventual total.
 *  - **stages** -- the leaf-session walk: each stage of the flow definition
 *    becomes one segment. Stages before the current one are `done`, the
 *    current one reflects session.status, the rest are `pending`.
 *
 * Returns `null` when there isn't enough information to project segments
 * honestly (no flow loaded, no children for a for_each parent, etc). The
 * row's caller falls back to the legacy single-bar lane in that case.
 *
 * Not exported as a default so callers spell the import explicitly.
 */
export function buildFlowProgress(input: {
  session: Pick<Session, "id" | "status" | "stage" | "config"> & { child_stats?: ChildStats | null };
  flow?: FlowDefinition | null;
  /** Children of a for_each parent. When provided + session has child_stats,
   *  the projection is `iterations`; iteration order is decided by
   *  `config.for_each_index` (falling back to created_at if missing). */
  children?: ProgressChild[] | null;
}): FlowProgress | null {
  const { session, flow, children } = input;

  // ── for_each parent path ────────────────────────────────────────────────
  // child_stats.total > 0 marks this row as a fan-out parent. With children
  // loaded we can render real per-iteration segments; without, we fall through
  // to the stage walk (or null) -- never synthesise from counts.
  const isFanOutParent = (session.child_stats?.total ?? 0) > 0;
  if (isFanOutParent && children && children.length > 0) {
    return projectIterations(session, children);
  }

  // ── leaf / multi-stage flow path ────────────────────────────────────────
  if (flow && flow.stages && flow.stages.length > 0) {
    return projectStages(session, flow);
  }

  return null;
}

// ── internal helpers ──────────────────────────────────────────────────────

interface ChildStats {
  running?: number;
  completed?: number;
  failed?: number;
  total?: number;
}

export interface ProgressChild {
  id: string;
  status: string;
  config?: { for_each_index?: number } | Record<string, unknown> | null;
  created_at?: string | null;
}

/** Map a raw session.status string to the visual segment state. */
function mapStatusToState(status: string): FlowSegmentState {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "running":
    case "waiting":
    case "ready":
      return "active";
    case "stopped":
    case "archived":
    case "deleting":
      return "skipped";
    default:
      return "pending";
  }
}

function projectIterations(
  session: Pick<Session, "id" | "status" | "config"> & { child_stats?: ChildStats | null },
  children: ProgressChild[],
): FlowProgress {
  // Sort children by config.for_each_index (canonical), then created_at as a
  // stable secondary key so reordering is deterministic across renders.
  const sorted = [...children].sort((a, b) => {
    const ai = readIterIndex(a);
    const bi = readIterIndex(b);
    if (ai != null && bi != null && ai !== bi) return ai - bi;
    if (ai != null && bi == null) return -1;
    if (ai == null && bi != null) return 1;
    const at = a.created_at ?? "";
    const bt = b.created_at ?? "";
    return at < bt ? -1 : at > bt ? 1 : a.id.localeCompare(b.id);
  });

  const declaredTotal = session.child_stats?.total ?? sorted.length;
  const total = Math.max(sorted.length, declaredTotal);

  const segments: FlowSegment[] = sorted.map((c, i) => {
    const idx = readIterIndex(c) ?? i;
    return {
      name: `iter ${idx}`,
      sessionId: c.id,
      state: mapStatusToState(c.status),
    };
  });

  // Fill in unknown / not-yet-spawned slots so the strip width matches the
  // declared loop size. These have no sessionId because they haven't been
  // created yet.
  for (let i = segments.length; i < total; i++) {
    segments.push({ name: `iter ${i}`, state: "pending" });
  }

  return { kind: "iterations", segments };
}

function projectStages(session: Pick<Session, "status" | "stage">, flow: FlowDefinition): FlowProgress {
  const stages = flow.stages;
  const currentIdx = stages.findIndex((s) => s.name === session.stage);
  const isCompleted = session.status === "completed";
  const isFailed = session.status === "failed";
  const isRunning = session.status === "running" || session.status === "waiting" || session.status === "ready";

  const segments: FlowSegment[] = stages.map((s, i) => {
    if (isCompleted) return { name: s.name, state: "done" };
    if (currentIdx < 0) return { name: s.name, state: "pending" };
    if (i < currentIdx) return { name: s.name, state: "done" };
    if (i === currentIdx) {
      if (isFailed) return { name: s.name, state: "failed" };
      if (isRunning) return { name: s.name, state: "active" };
      return { name: s.name, state: "pending" };
    }
    return { name: s.name, state: "pending" };
  });

  return { kind: "stages", segments };
}

function readIterIndex(c: ProgressChild): number | null {
  const v = (c.config as { for_each_index?: unknown } | null | undefined)?.for_each_index;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
