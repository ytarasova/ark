import { useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { RichSelect } from "../ui/RichSelect.js";

const GATE_OPTIONS = ["auto", "manual", "condition", "review"];

interface StageForm {
  name: string;
  agent: string;
  gate: string;
}

interface FlowFormProps {
  onClose: () => void;
  onSubmit: (form: any) => void;
  agents: any[];
}

export function FlowForm({ onClose, onSubmit, agents }: FlowFormProps) {
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
              <Button
                type="button"
                size="xs"
                variant="destructive"
                aria-label="Remove stage"
                onClick={() => removeStage(i)}
              >
                <X size={12} aria-hidden="true" />
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
