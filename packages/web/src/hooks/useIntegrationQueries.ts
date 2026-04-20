/**
 * Query hooks for the integrations framework (triggers + connectors + pairs).
 *
 * Shape matches the rest of the web hooks: thin react-query wrappers around
 * `api.*` that return `{ data, loading, error, refetch }`. The integrations
 * surface is tenant-agnostic in the current phase so no parameters are
 * required.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

/** Configured triggers for the current tenant. */
export function useTriggers(tenant?: string) {
  const q = useQuery({
    queryKey: ["triggers", tenant ?? "default"],
    queryFn: () => api.getTriggers(tenant),
  });
  return { data: q.data ?? [], loading: q.isLoading, error: q.error as Error | null, refetch: q.refetch };
}

/** Registered connectors (outbound half). */
export function useConnectors() {
  const q = useQuery({ queryKey: ["connectors"], queryFn: () => api.getConnectors() });
  return { data: q.data ?? [], loading: q.isLoading, error: q.error as Error | null, refetch: q.refetch };
}

/** Unified integration catalog -- one row per name, paired halves. */
export function useIntegrations() {
  const q = useQuery({ queryKey: ["integrations"], queryFn: () => api.getIntegrations() });
  return { data: q.data ?? [], loading: q.isLoading, error: q.error as Error | null, refetch: q.refetch };
}

/** Source connector maturity table (for the Triggers tab filter). */
export function useTriggerSources() {
  const q = useQuery({ queryKey: ["trigger-sources"], queryFn: () => api.getTriggerSources() });
  return { data: q.data ?? [], loading: q.isLoading, error: q.error as Error | null, refetch: q.refetch };
}
