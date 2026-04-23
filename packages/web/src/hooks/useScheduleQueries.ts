import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useSchedulesQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["schedules"], queryFn: api.getSchedules });
}
