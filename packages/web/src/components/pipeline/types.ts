/** Pipeline visualization types -- shared between PipelineViewer and FlowEditor. */

export type StageStatus = "completed" | "running" | "pending" | "failed" | "waiting";
export type GateType = "auto" | "manual" | "condition" | "review";
export type EdgeType = "linear" | "fanout" | "conditional" | "loopback";

export interface PipelineStage {
  name: string;
  agent: string | null;
  action: string | null;
  type: "normal" | "fan_out";
  gate: GateType;
  status: StageStatus;
  duration: number | null;
  cost: number | null;
  model: string | null;
  tokenCount: { input: number; output: number } | null;
  summary: string | null;
  toolCalls: { name: string; count: number }[];
  on_failure: string | null;
  verify: string[] | null;
  depends_on: string[];
  workers: PipelineStage[] | null;
}

export interface PipelineEdge {
  from: string;
  to: string;
  condition: string | null;
  label: string | null;
  isBackEdge: boolean;
}

export interface FlowDefinition {
  name: string;
  description: string;
  stages: FlowStageDefinition[];
  edges: FlowEdgeDefinition[];
}

export interface FlowStageDefinition {
  name: string;
  agent: string | null;
  action: string | null;
  type: string | null;
  gate: string;
  task: string | null;
  depends_on: string[];
  on_failure: string | null;
  verify: string[];
  optional: boolean;
  on_outcome?: Record<string, string>;
}

export interface FlowEdgeDefinition {
  from: string;
  to: string;
  condition: string | null;
  label: string | null;
}

export interface ToolCallDetail {
  name: string;
  args: string;
  duration: number;
}

export interface StageDetailData {
  stage: PipelineStage;
  summary: string | null;
  toolCalls: ToolCallDetail[];
  tokenCount: { input: number; output: number };
  cost: number;
  reviewFindings: string[] | null;
}
