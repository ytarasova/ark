import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useCostsQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["costs"], queryFn: api.getCosts });
}
