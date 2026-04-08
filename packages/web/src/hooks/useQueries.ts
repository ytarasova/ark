import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

// Sessions
export function useSessionsQuery() {
  return useQuery({ queryKey: ["sessions"], queryFn: api.getSessions });
}
export function useGroupsQuery() {
  return useQuery({ queryKey: ["groups"], queryFn: api.getGroups });
}

// Agents
export function useAgentsQuery() {
  return useQuery({ queryKey: ["agents"], queryFn: api.getAgents });
}

// Skills
export function useSkillsQuery() {
  return useQuery({ queryKey: ["skills"], queryFn: api.getSkills });
}

// Recipes
export function useRecipesQuery() {
  return useQuery({ queryKey: ["recipes"], queryFn: api.getRecipes });
}

// Flows
export function useFlowsQuery() {
  return useQuery({ queryKey: ["flows"], queryFn: api.getFlows });
}

// Compute
export function useComputeQuery() {
  return useQuery({ queryKey: ["compute"], queryFn: api.getCompute });
}

// Schedules
export function useSchedulesQuery() {
  return useQuery({ queryKey: ["schedules"], queryFn: api.getSchedules });
}

// Costs
export function useCostsQuery() {
  return useQuery({ queryKey: ["costs"], queryFn: api.getCosts });
}

// Memory
export function useMemoriesQuery() {
  return useQuery({ queryKey: ["memories"], queryFn: () => api.getMemories() });
}

// Session detail
export function useSessionDetail(id: string | null) {
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => api.getSession(id!),
    enabled: !!id,
  });
}

// Flow detail
export function useFlowDetail(name: string | null) {
  return useQuery({
    queryKey: ["flow", name],
    queryFn: () => api.getFlowDetail(name!),
    enabled: !!name,
  });
}

// Session output (polling)
export function useSessionOutput(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["session-output", id],
    queryFn: () => api.getOutput(id!),
    enabled: !!id && enabled,
    refetchInterval: 2000,
  });
}
