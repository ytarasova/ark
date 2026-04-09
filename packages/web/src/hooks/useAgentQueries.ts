import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useAgentsQuery() {
  return useQuery({ queryKey: ["agents"], queryFn: api.getAgents });
}
