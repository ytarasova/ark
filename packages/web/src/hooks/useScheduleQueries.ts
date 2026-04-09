import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useSchedulesQuery() {
  return useQuery({ queryKey: ["schedules"], queryFn: api.getSchedules });
}
