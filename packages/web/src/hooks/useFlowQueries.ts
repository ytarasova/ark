import { useQuery } from "@tanstack/react-query";
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
