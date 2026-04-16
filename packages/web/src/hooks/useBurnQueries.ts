import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./useApi.js";

export type BurnPeriod = "today" | "week" | "30days" | "month";

export function useBurnSummary(period: BurnPeriod) {
  return useQuery({
    queryKey: ["burn", "summary", period],
    queryFn: () => api.getBurnSummary(period),
  });
}

export function useBurnSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (force?: boolean) => api.syncBurn(force),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["burn"] });
    },
  });
}
