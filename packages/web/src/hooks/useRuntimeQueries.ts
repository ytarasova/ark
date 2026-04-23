import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useRuntimesQuery() {
  return useQuery({ queryKey: ["runtimes"], queryFn: api.getRuntimes });
}

/**
 * Canonical model catalog (file-backed three-tier store, surfaced over
 * `model/list`). Each entry carries `id`, `display`, `provider`, optional
 * aliases, and per-provider slugs. The catalog is the single source of
 * truth for the model selector on agent forms; runtime YAMLs no longer
 * advertise their own model list.
 */
export function useModelsQuery() {
  return useQuery({ queryKey: ["models"], queryFn: api.getModels });
}
