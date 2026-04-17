import { useState, useMemo, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useFlowsQuery, useFlowDetail } from "../hooks/useFlowQueries.js";
import { useAgentsQuery } from "../hooks/useAgentQueries.js";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Separator } from "./ui/separator.js";
import { GitBranch } from "lucide-react";
import { RichSelect } from "./ui/RichSelect.js";
import { PipelineViewer } from "./pipeline/PipelineViewer.js";
import type { PipelineStage, PipelineEdge as PipelineEdgeType } from "./pipeline/types.js";

const GATE_VARIANT: Record<string, "success" | "warning" | "info" | "default"> = {
  auto: "success",
  manual: "warning",
  condition: "info",
  review: "default",
};

const GATE_OPTIONS = ["auto", "manual", "condition", "review"];

interface StageForm {
  name: string;
  agent: string;
  gate: string;
}

function FlowForm({
  onClose,
  onSubmit,
  agents,
}: {
  onClose: () => void;
  onSubmit: (form: any) => void;
  agents: any[];
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stages, setStages] = useState<StageForm[]>([{ name: "", agent: "", gate: "auto" }]);

  function updateStage(i: number, field: keyof StageForm, val: string) {
    setStages((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: val } : s)));
  }

  function addStage() {
    setStages((prev) => [...prev, { name: "", agent: "", gate: "auto" }]);
  }

  function removeStage(i: number) {
    setStages((prev) => prev.filter((_, idx) => idx !== i));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const validStages = stages.filter((s) => s.name.trim());
    if (validStages.length === 0) return;
    onSubmit({
      name: name.trim(),
      description: description.trim() || undefined,
      stages: validStages.map((s) => ({
        name: s.name.trim(),
        agent: s.agent || undefined,
        gate: s.gate || "auto",
      })),
    });
  }

  return (
    <div className="flex flex-col h-full p-5 overflow-y-auto">
      <h2 className="text-base font-semibold text-foreground mb-5">New Flow</h2>
      <form onSubmit={handleSubmit} className="flex flex-col">
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Name *
          </label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-flow" />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Description
          </label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this flow do?"
          />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Stages *
          </label>
          {stages.map((stage, i) => (
            <div key={i} className="flex gap-2 mb-2 items-center">
              <Input
                className="flex-1"
                placeholder="Stage name"
                value={stage.name}
                onChange={(e) => updateStage(i, "name", e.target.value)}
              />
              <div className="w-[140px] flex-shrink-0">
                <RichSelect
                  value={stage.agent}
                  onChange={(v) => updateStage(i, "agent", v)}
                  placeholder="-- agent --"
                  options={[
                    { value: "", label: "-- agent --" },
                    ...agents.map((a: any) => ({ value: a.name, label: a.name })),
                  ]}
                />
              </div>
              <div className="w-[120px] flex-shrink-0">
                <RichSelect
                  value={stage.gate}
                  onChange={(v) => updateStage(i, "gate", v)}
                  options={GATE_OPTIONS.map((g) => ({
                    value: g,
                    label: g,
                    description:
                      g === "auto"
                        ? "No human intervention"
                        : g === "manual"
                          ? "Requires approval"
                          : g === "condition"
                            ? "Expression-based"
                            : "External review",
                  }))}
                />
              </div>
              <Button type="button" size="xs" variant="destructive" onClick={() => removeStage(i)}>
                x
              </Button>
            </div>
          ))}
          <Button type="button" size="xs" variant="outline" onClick={addStage}>
            + Add Stage
          </Button>
        </div>
        <div className="flex gap-2 pt-4 border-t border-border mt-auto">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm">
            Create Flow
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Convert flow definition stages to PipelineStage[] for the DAG viewer. */
function flowStagesToPipeline(stages: any[]): PipelineStage[] {
  return (stages || []).map((s: any) => {
    const name = typeof s === "string" ? s : s.name;
    const gate = typeof s === "string" ? "auto" : s.gate || "auto";
    return {
      name,
      agent: typeof s === "string" ? null : s.agent || null,
      action: typeof s === "string" ? null : s.action || null,
      type: typeof s !== "string" && s.type === "fan_out" ? "fan_out" : "normal",
      gate: gate as "auto" | "manual" | "condition" | "review",
      status: "pending" as const,
      duration: null,
      cost: null,
      model: null,
      tokenCount: null,
      summary: null,
      toolCalls: [],
      on_failure: typeof s === "string" ? null : s.on_failure || null,
      verify: typeof s === "string" ? null : s.verify || null,
      depends_on: typeof s === "string" ? [] : s.depends_on || [],
      workers: null,
    };
  });
}

/** Build edges from explicit edges + depends_on + implicit linear chain. */
function flowEdgesToPipeline(stages: any[], explicitEdges: any[]): PipelineEdgeType[] {
  const edges: PipelineEdgeType[] = [];
  const edgeSet = new Set<string>();

  // Add explicit edges first
  for (const e of explicitEdges || []) {
    const key = `${e.from}->${e.to}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push({
        from: e.from,
        to: e.to,
        condition: e.condition || null,
        label: e.label || null,
        isBackEdge: false,
      });
    }
  }

  // Add edges from depends_on
  for (const s of stages || []) {
    if (typeof s === "string") continue;
    for (const dep of s.depends_on || []) {
      const key = `${dep}->${s.name}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({ from: dep, to: s.name, condition: null, label: null, isBackEdge: false });
      }
    }
  }

  // If no edges at all, build a linear chain
  if (edges.length === 0 && stages && stages.length > 1) {
    for (let i = 1; i < stages.length; i++) {
      const prev = typeof stages[i - 1] === "string" ? stages[i - 1] : stages[i - 1].name;
      const curr = typeof stages[i] === "string" ? stages[i] : stages[i].name;
      edges.push({ from: prev, to: curr, condition: null, label: null, isBackEdge: false });
    }
  }

  return edges;
}

/** DAG visualization for a flow definition using PipelineViewer. */
function FlowDAG({ selected }: { selected: any }) {
  const pipelineStages = useMemo(() => flowStagesToPipeline(selected.stages), [selected.stages]);
  const pipelineEdges = useMemo(
    () => flowEdgesToPipeline(selected.stages, selected.edges),
    [selected.stages, selected.edges],
  );

  if (!selected.stages || selected.stages.length === 0) return null;

  return (
    <div className="mb-5">
      <PipelineViewer stages={pipelineStages} edges={pipelineEdges} currentStage={null} flowName={selected.name} />
    </div>
  );
}

interface FlowsViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
  initialSelectedName?: string | null;
  onSelectedChange?: (name: string | null) => void;
}

export function FlowsView({
  showCreate = false,
  onCloseCreate,
  initialSelectedName,
  onSelectedChange,
}: FlowsViewProps) {
  const queryClient = useQueryClient();
  const { data: flows = [] } = useFlowsQuery();
  const { data: agents = [] } = useAgentsQuery();
  const [selectedName, setSelectedNameInternal] = useState<string | null>(initialSelectedName ?? null);
  const setSelectedName = (name: string | null) => {
    setSelectedNameInternal(name);
    onSelectedChange?.(name);
  };
  const { data: selectedDetail } = useFlowDetail(selectedName);
  const selected = selectedDetail || (selectedName ? flows.find((f: any) => f.name === selectedName) : null);
  const [actionMsg, setActionMsg] = useState<{ text: string; type: string } | null>(null);

  function showActionMsg(text: string, type: string) {
    setActionMsg({ text, type });
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function handleCreate(form: any) {
    try {
      await api.createFlow(form);
      onCloseCreate?.();
      queryClient.invalidateQueries({ queryKey: ["flows"] });
    } catch (err: any) {
      showActionMsg(err.message || "Failed to create flow", "error");
    }
  }

  async function handleDelete(name: string) {
    try {
      await api.deleteFlow(name);
      setSelectedName(null);
      queryClient.invalidateQueries({ queryKey: ["flows"] });
    } catch (err: any) {
      showActionMsg(err.message || "Failed to delete flow", "error");
    }
  }

  if (!flows.length && !showCreate) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <GitBranch size={28} className="text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No flows found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      {/* Left: list panel */}
      <div className="border-r border-border overflow-y-auto" role="listbox" aria-label="Flows">
        {flows.map((f: any) => {
          const stageCount = f.stages?.length ?? 0;
          return (
            <div
              key={f.name}
              className={cn(
                "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                "hover:bg-accent",
                selected?.name === f.name && "bg-accent border-l-2 border-l-primary font-semibold",
              )}
              onClick={() => setSelectedName(f.name)}
            >
              <span className="text-foreground truncate">{f.name}</span>
              <Badge variant="secondary" className="text-[10px]">
                {stageCount} stage{stageCount !== 1 ? "s" : ""}
              </Badge>
            </div>
          );
        })}
      </div>
      {/* Right: detail panel or create form */}
      <div className="overflow-y-auto bg-background">
        {showCreate ? (
          <FlowForm onClose={() => onCloseCreate?.()} onSubmit={handleCreate} agents={agents} />
        ) : selected ? (
          <>
            <div className="p-5">
              <h2 className="text-lg font-semibold text-foreground mb-1">{selected.name}</h2>
              {selected.description && <p className="text-sm text-muted-foreground mb-5">{selected.description}</p>}

              {/* DAG pipeline visualization */}
              <FlowDAG selected={selected} />

              {/* Stage details */}
              {selected.stages && selected.stages.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                    Stages
                  </h3>
                  <Separator className="mb-2" />
                  <div className="flex flex-col gap-3">
                    {selected.stages.map((s: any, i: number) => {
                      const stageName = typeof s === "string" ? s : s.name;
                      const agent = typeof s === "string" ? null : s.agent;
                      const gate = typeof s === "string" ? "auto" : s.gate || "auto";
                      const optional = typeof s !== "string" && s.optional;
                      const onFailure = typeof s !== "string" ? s.on_failure : null;
                      const verify = typeof s !== "string" ? s.verify : null;
                      const dependsOn = typeof s !== "string" ? s.depends_on : null;
                      const action = typeof s !== "string" ? s.action : null;
                      const stageType = typeof s !== "string" ? s.type : null;

                      return (
                        <div key={i} className="border border-border/50 rounded-lg p-3 bg-[var(--bg-code)]/50">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-[10px] font-mono text-muted-foreground w-5">{i + 1}</span>
                            <span className="text-[13px] font-semibold text-foreground">{stageName}</span>
                            <Badge variant={GATE_VARIANT[gate] || "success"} className="text-[10px]">
                              {gate}
                            </Badge>
                            {optional && (
                              <Badge variant="info" className="text-[10px]">
                                optional
                              </Badge>
                            )}
                            {stageType && stageType !== "-" && (
                              <Badge variant="secondary" className="text-[10px]">
                                {stageType}
                              </Badge>
                            )}
                          </div>
                          <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1 text-[11px] ml-5">
                            {agent && (
                              <>
                                <span className="text-muted-foreground">Agent</span>
                                <span className="text-card-foreground font-mono">{agent}</span>
                              </>
                            )}
                            {action && (
                              <>
                                <span className="text-muted-foreground">Action</span>
                                <span className="text-card-foreground font-mono">{action}</span>
                              </>
                            )}
                            <span className="text-muted-foreground">Gate</span>
                            <span className="text-card-foreground">
                              {gate === "auto" && "Automatic -- no human intervention needed"}
                              {gate === "manual" && "Manual -- requires human approval to proceed"}
                              {gate === "condition" && "Conditional -- proceeds based on expression evaluation"}
                              {gate === "review" && "Review -- waits for external review (e.g. PR approval)"}
                            </span>
                            {dependsOn && dependsOn.length > 0 && (
                              <>
                                <span className="text-muted-foreground">Depends on</span>
                                <span className="text-card-foreground font-mono">{dependsOn.join(", ")}</span>
                              </>
                            )}
                            {onFailure && (
                              <>
                                <span className="text-muted-foreground">On failure</span>
                                <span className="text-[var(--waiting)] font-mono">{onFailure}</span>
                              </>
                            )}
                            {verify && verify.length > 0 && (
                              <>
                                <span className="text-muted-foreground">Verify</span>
                                <span className="text-card-foreground font-mono">{verify.join(", ")}</span>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Show delete button for non-builtin flows */}
              {(() => {
                const listEntry = flows.find((f: any) => f.name === selected.name);
                const source = selected.source || listEntry?.source;
                return source && source !== "builtin" ? (
                  <div className="mt-5 flex gap-1.5">
                    <Button variant="destructive" size="xs" onClick={() => handleDelete(selected.name)}>
                      Delete Flow
                    </Button>
                  </div>
                ) : null;
              })()}
              {actionMsg && (
                <div
                  className={cn(
                    "mt-1.5 text-xs",
                    actionMsg.type === "error" ? "text-[var(--failed)]" : "text-[var(--running)]",
                  )}
                >
                  {actionMsg.text}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Select a flow</div>
        )}
      </div>
    </div>
  );
}
