import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useComputeQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["compute"], queryFn: api.getCompute });
}
