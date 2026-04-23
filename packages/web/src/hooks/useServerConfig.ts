import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export interface ServerConfig {
  hotkeys: unknown;
  theme: unknown;
  profile: unknown;
  /** Deployment mode, authoritative. */
  mode?: "local" | "hosted";
  /** @deprecated Back-compat flag; new clients should key off `mode`. */
  hosted?: boolean;
}

/**
 * Server config (hotkeys / theme / profile / mode).
 * Cached for the session -- it doesn't change without a server restart.
 *
 * Mode-sensitive components should pull their binding from `useAppMode()`
 * (see `providers/AppModeProvider.tsx`) rather than inspect the `mode` field
 * directly. `useServerConfig` is for the handful of call sites that need
 * hotkeys / theme / profile.
 */
export function useServerConfig() {
  const api = useApi();
  return useQuery<ServerConfig>({
    queryKey: ["config", "server"],
    queryFn: () => api.getConfig(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
