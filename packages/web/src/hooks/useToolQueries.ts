import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useSkillsQuery() {
  return useQuery({ queryKey: ["skills"], queryFn: api.getSkills });
}

export function useRecipesQuery() {
  return useQuery({ queryKey: ["recipes"], queryFn: api.getRecipes });
}
