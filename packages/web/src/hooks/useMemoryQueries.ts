import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useMemoriesQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["memories"], queryFn: () => api.getMemories() });
}
