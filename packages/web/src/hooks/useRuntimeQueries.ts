import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useRuntimesQuery() {
  return useQuery({ queryKey: ["runtimes"], queryFn: api.getRuntimes });
}
