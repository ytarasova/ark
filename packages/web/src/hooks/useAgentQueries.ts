import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useAgentsQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["agents"], queryFn: api.getAgents });
}
