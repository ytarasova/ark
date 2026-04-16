import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./useApi.js";

export type BurnPeriod = "today" | "week" | "30days" | "month";

export function useBurnSummary(period: BurnPeriod) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return useQuery({
    queryKey: ["burn", "summary", period, tz],
    queryFn: () => api.getBurnSummary(period, tz),
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
