import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useComputeQuery() {
  return useQuery({ queryKey: ["compute"], queryFn: api.getCompute });
}
