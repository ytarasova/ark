import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

/**
 * Server config (hotkeys / theme / profile / hosted flag).
 * Cached for the session -- it doesn't change without a server restart.
 */
export function useServerConfig() {
  return useQuery<{ hotkeys: unknown; theme: unknown; profile: unknown; hosted?: boolean }>({
    queryKey: ["config", "server"],
    queryFn: () => api.getConfig(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/** True when the web client is talking to a multi-tenant / hosted Ark server. */
export function useHostedMode(): boolean {
  const { data } = useServerConfig();
  return !!data?.hosted;
}
