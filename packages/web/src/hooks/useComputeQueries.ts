import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";
import type { ComputeSnapshot } from "../components/compute/types.js";

/** Compute target list. Cached under ["compute"]. */
export function useComputeQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["compute"], queryFn: api.getCompute });
}

/**
 * Live snapshot + metrics for a single compute target.
 *
 * Polls every 5s while a target is selected. Returns `null` when `name` is
 * unset so callers can render their empty-state without disabling the hook.
 *
 * `name === "local"` is a UX quirk of the selector: the server expects
 * `undefined` for the implicit local target, not the literal string "local".
 */
export function useComputeSnapshotQuery(name: string | null | undefined) {
  const api = useApi();
  return useQuery<ComputeSnapshot | null>({
    queryKey: ["compute", "snapshot", name ?? null],
    queryFn: () => api.getComputeSnapshot(name === "local" ? undefined : name!),
    enabled: !!name,
    refetchInterval: name ? 5_000 : false,
    // 5s poll + aggressive stale means the initial render for a just-clicked
    // target is snappy without double-fetching every paint.
    staleTime: 2_000,
  });
}

/**
 * List of currently-running sessions, for the compute detail "attached
 * sessions" panel. Polls every 15s; callers are expected to filter by
 * compute_name client-side.
 */
export function useRunningSessionsQuery() {
  const api = useApi();
  return useQuery({
    queryKey: ["sessions", { status: "running" }],
    queryFn: () => api.getSessions({ status: "running" }),
    refetchInterval: 15_000,
    // 15s cadence is forgiving; keep last-known list fresh on the view.
    staleTime: 10_000,
  });
}
