import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useFlowsQuery, useFlowDetail, useAgentsQuery } from "../hooks/useQueries.js";
import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { GitBranch } from "lucide-react";

const GATE_VARIANT: Record<string, "success" | "warning" | "info" | "default"> = {
  auto: "success",
  manual: "warning",
  condition: "info",
  review: "default",
};

const GATE_OPTIONS = ["auto", "manual", "condition", "review"];

const selectClassName =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring appearance-none pr-8 bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_0.75rem_center]";

interface StageForm {
  name: string;
  agent: string;
  gate: string;
}

function FlowForm({ onClose, onSubmit, agents }: {
  onClose: () => void;
  onSubmit: (form: any) => void;
  agents: any[];
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stages, setStages] = useState<StageForm[]>([{ name: "", agent: "", gate: "auto" }]);

  function updateStage(i: number, field: keyof StageForm, val: string) {
    setStages(prev => prev.map((s, idx) => idx === i ? { ...s, [field]: val } : s));
  }

  function addStage() {
    setStages(prev => [...prev, { name: "", agent: "", gate: "auto" }]);
  }

  function removeStage(i: number) {
    setStages(prev => prev.filter((_, idx) => idx !== i));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const validStages = stages.filter(s => s.name.trim());
    if (validStages.length === 0) return;
    onSubmit({
      name: name.trim(),
      description: description.trim() || undefined,
      stages: validStages.map(s => ({
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
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Name *</label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-flow" />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Description</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this flow do?" />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Stages *</label>
          {stages.map((stage, i) => (
            <div key={i} className="flex gap-2 mb-2 items-center">
              <Input
                className="flex-1"
                placeholder="Stage name"
                value={stage.name}
                onChange={(e) => updateStage(i, "name", e.target.value)}
              />
              <select
                className={cn(selectClassName, "w-[140px] flex-shrink-0")}
                value={stage.agent}
                onChange={(e) => updateStage(i, "agent", e.target.value)}
              >
                <option value="">-- agent --</option>
                {agents.map((a: any) => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </select>
              <select
                className={cn(selectClassName, "w-[120px] flex-shrink-0")}
                value={stage.gate}
                onChange={(e) => updateStage(i, "gate", e.target.value)}
              >
                {GATE_OPTIONS.map(g => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
              <Button type="button" size="xs" variant="destructive" onClick={() => removeStage(i)}>x</Button>
            </div>
          ))}
          <Button type="button" size="xs" variant="outline" onClick={addStage}>+ Add Stage</Button>
        </div>
        <div className="flex gap-2 pt-4 border-t border-border mt-auto">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm">Create Flow</Button>
        </div>
      </form>
    </div>
  );
}

interface FlowsViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
}

export function FlowsView({ showCreate = false, onCloseCreate }: FlowsViewProps) {
  const queryClient = useQueryClient();
  const { data: flows = [] } = useFlowsQuery();
  const { data: agents = [] } = useAgentsQuery();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const { data: selectedDetail } = useFlowDetail(selectedName);
  const selected = selectedDetail || (selectedName ? flows.find((f: any) => f.name === selectedName) : null);

  async function handleCreate(form: any) {
    try {
      await api.createFlow(form);
      onCloseCreate?.();
      queryClient.invalidateQueries({ queryKey: ["flows"] });
    } catch {}
  }

  async function handleDelete(name: string) {
    try {
      await api.deleteFlow(name);
      setSelectedName(null);
      queryClient.invalidateQueries({ queryKey: ["flows"] });
    } catch {}
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
      <div className="bg-card border-r border-border overflow-y-auto">
        {flows.map((f: any) => {
          const stageCount = f.stages?.length ?? 0;
          return (
            <div
              key={f.name}
              className={cn(
                "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                "hover:bg-accent",
                selected?.name === f.name && "bg-accent border-l-2 border-l-primary font-semibold"
              )}
              onClick={() => setSelectedName(f.name)}
            >
              <span className="text-foreground truncate">{f.name}</span>
              <Badge variant="secondary" className="text-[10px]">{stageCount} stage{stageCount !== 1 ? "s" : ""}</Badge>
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
              {selected.description && (
                <p className="text-sm text-muted-foreground mb-5">{selected.description}</p>
              )}
              {selected.stages && selected.stages.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Stages</h3>
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border">#</th>
                        <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border">Name</th>
                        <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border">Agent</th>
                        <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border">Gate</th>
                        <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border">Type</th>
                        <th className="text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground p-2 px-3 border-b border-border">Optional</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.stages.map((s: any, i: number) => {
                        // Handle both object stages (from detail endpoint) and string stages (from list endpoint)
                        const stageName = typeof s === "string" ? s : s.name;
                        const agent = typeof s === "string" ? "-" : (s.agent || "-");
                        const gate = typeof s === "string" ? "auto" : (s.gate || "auto");
                        const stageType = typeof s === "string" ? "-" : (s.type || "-");
                        const optional = typeof s === "string" ? false : !!s.optional;
                        return (
                          <tr key={i} className="hover:bg-accent transition-colors">
                            <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-muted-foreground font-mono text-[11px]">{i + 1}</td>
                            <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-foreground font-semibold">{stageName || "-"}</td>
                            <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground">{agent}</td>
                            <td className="p-2.5 px-3 text-[13px] border-b border-border/50">
                              <Badge variant={GATE_VARIANT[gate] || "success"} className="text-[10px]">
                                {gate}
                              </Badge>
                            </td>
                            <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground">{stageType}</td>
                            <td className="p-2.5 px-3 text-[13px] border-b border-border/50 text-card-foreground">
                              {optional && <Badge variant="info" className="text-[10px]">optional</Badge>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
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
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select a flow
          </div>
        )}
      </div>
    </div>
  );
}
