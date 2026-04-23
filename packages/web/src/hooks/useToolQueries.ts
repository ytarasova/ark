import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useSkillsQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["skills"], queryFn: api.getSkills });
}

export function useRecipesQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["recipes"], queryFn: api.getRecipes });
}
