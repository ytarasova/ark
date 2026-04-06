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
  _source?: "builtin" | "global" | "project";
  _path?: string;
}
