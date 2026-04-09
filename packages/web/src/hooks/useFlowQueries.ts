import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useFlowsQuery() {
  return useQuery({ queryKey: ["flows"], queryFn: api.getFlows });
}

export function useFlowDetail(name: string | null) {
  return useQuery({
    queryKey: ["flow", name],
    queryFn: () => api.getFlowDetail(name!),
    enabled: !!name,
  });
}
