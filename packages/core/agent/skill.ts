/**
 * Skill registry - types for reusable prompt fragments.
 *
 * Skills are YAML files with: name, description, prompt, tags.
 * Three-tier resolution: builtin (skills/), global (~/.ark/skills/), project (.ark/skills/).
 *
 * CRUD operations are on the SkillStore (app.skills). This module only exports types.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  tags?: string[];
  _source?: "builtin" | "project" | "global";
}
