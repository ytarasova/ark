export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  tags?: string[];
  _source?: "builtin" | "project" | "global";
}

export interface RuntimeDefinition {
  name: string;
  description?: string;
  type: "claude-code" | "cli-agent" | "subprocess";
  command?: string[];
  task_delivery?: "stdin" | "file" | "arg";
  models?: Array<{ id: string; label: string }>;
  default_model?: string;
  permission_mode?: string;
  env?: Record<string, string>;
  _source?: "builtin" | "global" | "project";
  _path?: string;
}

export interface AgentDefinition {
  name: string;
  description: string;
  model: string;
  max_turns: number;
  system_prompt: string;
  tools: string[];
  mcp_servers: (string | Record<string, unknown>)[];
  skills: string[];
  memories: string[];
  context: string[];
  permission_mode: string;
  env: Record<string, string>;
  runtime?: string;
  command?: string[];
  task_delivery?: "stdin" | "file" | "arg";
  _source?: "builtin" | "global" | "project";
  _path?: string;
}
