export type GateType = "auto" | "manual" | "condition" | "review";

export interface StageDefinition {
  name: string;
  type?: "agent" | "action" | "fork";
  agent?: string;
  action?: string;
  task?: string;
  gate: GateType;
  autonomy?: "full" | "execute" | "edit" | "read-only";
  on_failure?: string;
  optional?: boolean;
  model?: string;
  // Fork-specific
  strategy?: string;
  max_parallel?: number;
  subtasks?: { name: string; task: string }[];
}

export interface FlowDefinition {
  name: string;
  description?: string;
  stages: StageDefinition[];
}
