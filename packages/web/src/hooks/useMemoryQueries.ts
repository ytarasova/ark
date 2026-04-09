import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useMemoriesQuery() {
  return useQuery({ queryKey: ["memories"], queryFn: () => api.getMemories() });
}
