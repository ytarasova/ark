import { useQuery, useQueries } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useFlowsQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["flows"], queryFn: api.getFlows });
}

export function useFlowDetail(name: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["flow", name],
    queryFn: () => api.getFlowDetail(name!),
    enabled: !!name,
  });
}

/**
 * Fetch flow-stage definitions for many flow names in parallel. Returns a
 * `Record<flowName, stages[]>` suitable for pipeline visualisation. Replaces
 * the imperative useEffect fan-out dance in SessionsPage.
 */
export function useFlowStagesMap(flowNames: string[]): Record<string, any[]> {
  const api = useApi();
  const unique = Array.from(new Set(flowNames.filter(Boolean)));
  const queries = useQueries({
    queries: unique.map((name) => ({
      queryKey: ["flow-stages", name],
      queryFn: async () => {
        const d = await api.getFlowDetail(name);
        return d.stages ?? [];
      },
      staleTime: 60_000,
    })),
  });
  const out: Record<string, any[]> = {};
  unique.forEach((name, i) => {
    const data = queries[i]?.data;
    if (data) out[name] = data;
  });
  return out;
}
