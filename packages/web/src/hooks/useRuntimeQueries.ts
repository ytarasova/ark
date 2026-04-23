import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useRuntimesQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["runtimes"], queryFn: api.getRuntimes });
}
