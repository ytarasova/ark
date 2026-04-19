export interface RecipeVariable {
  name: string;
  description: string;
  required?: boolean;
  default?: string;
}

export interface RecipeParameter {
  key: string;
  type: "string" | "number" | "boolean" | "select" | "file";
  description?: string;
  required?: boolean;
  default?: string;
  options?: string[];
}

export interface SubRecipeRef {
  name: string;
  recipe: string;
  values?: Record<string, string>;
}

export interface RecipeDefinition {
  name: string;
  description: string;
  repo?: string;
  flow: string;
  agent?: string;
  compute?: string;
  group?: string;
  variables: RecipeVariable[];
  parameters?: RecipeParameter[];
  defaults?: Record<string, string>;
  sub_recipes?: SubRecipeRef[];
  _source?: "builtin" | "project" | "global";
}

export type GateType = "auto" | "manual" | "condition" | "review";

export interface FlowEdgeDefinition {
  from: string;
  to: string;
  condition?: string; // JS expression evaluated against session data
  label?: string;
}

export interface StageDefinition {
  name: string;
  type?: "agent" | "action" | "fork";
  agent?: string;
  action?: string;
  task?: string;
  gate: GateType;
  autonomy?: "full" | "execute" | "edit" | "read-only";
  on_failure?: string;
  /**
   * Outcome-based routing. Maps outcome labels reported by the agent
   * to target stage names. When an agent completes with an `outcome`
   * field, the flow advances to the mapped stage instead of the linear next.
   *
   * Example:
   *   on_outcome:
   *     approved: deploy
   *     rejected: revise
   *     needs_info: clarify
   *
   * If the outcome doesn't match any key, falls back to linear next stage.
   */
  on_outcome?: Record<string, string>;
  optional?: boolean;
  model?: string;
  /** Scripts that must pass before stage completion. */
  verify?: string[];
  /**
   * Runtime isolation mode for this stage.
   * - "fresh" (default): each stage gets a fresh runtime -- no --resume from prior stage.
   *   Context is passed structurally via task prompt (PLAN.md, git log, events).
   * - "continue": preserve the previous stage's claude_session_id so the next
   *   dispatch resumes the same conversation. Useful for stages that refine
   *   the same agent's output (e.g. review -> fixup).
   */
  isolation?: "fresh" | "continue";
  // Fork-specific
  strategy?: string;
  max_parallel?: number;
  subtasks?: { name: string; task: string }[];
}

/** Declarative description of a file input slot a flow requires. */
export interface FlowFileInput {
  /** User-facing description of what this file is for. */
  description?: string;
  /** Whether dispatch is blocked without this input. Default false. */
  required?: boolean;
  /** Comma-separated list of suggested file extensions (".yaml,.yml"). UI hint. */
  accept?: string;
}

/** Declarative description of a param input a flow requires. */
export interface FlowParamInput {
  description?: string;
  required?: boolean;
  /** Default value if user does not supply one. */
  default?: string;
  /** Optional regex the submitted value must match. */
  pattern?: string;
}

/**
 * Declarative inputs contract for a flow. Drives the dispatch-time form
 * in the web UI and the CLI validator. All inputs end up flattened into
 * `session.config.inputs.{files,params}` and reachable via
 * `{inputs.files.<role>}` / `{inputs.params.<key>}` templating.
 *
 * Dispatch always accepts additional ad-hoc params beyond what is declared
 * here. Files are role-keyed and only the declared roles are validated; the
 * UI may still allow attaching arbitrary extras.
 */
export interface FlowInputsSchema {
  files?: Record<string, FlowFileInput>;
  params?: Record<string, FlowParamInput>;
}

export interface FlowDefinition {
  name: string;
  description?: string;
  stages: StageDefinition[];
  edges?: FlowEdgeDefinition[];
  inputs?: FlowInputsSchema;
  source?: "builtin" | "user";
}
