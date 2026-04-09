import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useCostsQuery() {
  return useQuery({ queryKey: ["costs"], queryFn: api.getCosts });
}
