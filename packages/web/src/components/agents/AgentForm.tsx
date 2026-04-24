import { useMemo, useState, type FormEvent } from "react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { RichSelect, type RichSelectOption } from "../ui/RichSelect.js";
import { useModelsQuery } from "../../hooks/useRuntimeQueries.js";

const TOOL_OPTIONS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch"];

interface AgentFormProps {
  onClose: () => void;
  onSubmit: (form: any) => void;
  agent?: any;
  isEdit?: boolean;
  runtimes?: any[];
}

export function AgentForm({ onClose, onSubmit, agent, isEdit, runtimes = [] }: AgentFormProps) {
  const { data: models = [] } = useModelsQuery();
  const [form, setForm] = useState({
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    model: agent?.model ?? "sonnet",
    runtime: agent?.runtime ?? "claude-code",
    max_turns: String(agent?.max_turns ?? 200),
    tools: agent?.tools ?? ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    permission_mode: agent?.permission_mode ?? "bypassPermissions",
    scope: "project",
    system_prompt: agent?.system_prompt ?? "",
  });

  // Build the model selector options from the catalog. Sorted by provider,
  // then by display name. If the agent's current `model` isn't in the
  // catalog (e.g. an agent was saved with an unknown alias), surface it as
  // a disabled `<unknown: {id}>` entry so the value stays editable without
  // the select appearing empty.
  const modelOptions = useMemo<RichSelectOption[]>(() => {
    const opts: RichSelectOption[] = [];
    const sorted = [...models].sort((a: any, b: any) => {
      const p = String(a.provider ?? "").localeCompare(String(b.provider ?? ""));
      if (p !== 0) return p;
      return String(a.display ?? a.id).localeCompare(String(b.display ?? b.id));
    });
    for (const m of sorted) {
      const anyM = m as { id: string; display?: string; provider?: string; aliases?: string[] };
      opts.push({
        value: anyM.id,
        label: `${anyM.display ?? anyM.id} -- ${anyM.id}`,
        description: anyM.provider ?? undefined,
      });
    }
    const current = String(form.model ?? "");
    const isKnown = sorted.some((m: any) => m.id === current || (m.aliases ?? []).includes(current));
    if (current && !isKnown) {
      opts.unshift({ value: current, label: `<unknown: ${current}>` });
    }
    return opts;
  }, [models, form.model]);

  function update(key: string, val: any) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function toggleTool(tool: string) {
    setForm((prev) => ({
      ...prev,
      tools: prev.tools.includes(tool) ? prev.tools.filter((t: string) => t !== tool) : [...prev.tools, tool],
    }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isEdit && !form.name.trim()) return;
    onSubmit({ ...form, max_turns: parseInt(form.max_turns) || 200 });
  }

  return (
    <div className="flex flex-col h-full p-5 overflow-y-auto">
      <h2 className="text-base font-semibold text-foreground mb-5">
        {isEdit ? `Edit Agent: ${agent?.name}` : "New Agent"}
      </h2>
      <form onSubmit={handleSubmit} className="flex flex-col">
        {!isEdit && (
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
              Name *
            </label>
            <Input
              autoFocus
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="my-agent"
            />
          </div>
        )}
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Description
          </label>
          <Input
            value={form.description}
            onChange={(e) => update("description", e.target.value)}
            placeholder="What does this agent do?"
          />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Model
          </label>
          <RichSelect
            value={form.model}
            onChange={(v) => update("model", v)}
            options={modelOptions}
            placeholder="Select a model"
            searchable
          />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Runtime
          </label>
          <RichSelect
            value={form.runtime}
            onChange={(v) => update("runtime", v)}
            options={
              runtimes.length > 0
                ? runtimes.map((r: any) => ({
                    value: r.name,
                    label: r.name,
                    description: r.description || r.type || undefined,
                  }))
                : [
                    { value: "claude-code", label: "claude-code", description: "Claude Code CLI runtime" },
                    { value: "cli-agent", label: "cli-agent", description: "Generic CLI agent" },
                  ]
            }
          />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Max Turns
          </label>
          <Input value={form.max_turns} onChange={(e) => update("max_turns", e.target.value)} placeholder="200" />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Tools
          </label>
          <div className="flex flex-wrap gap-2">
            {TOOL_OPTIONS.map((tool) => (
              <label key={tool} className="flex items-center gap-1.5 text-[13px] text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.tools.includes(tool)}
                  onChange={() => toggleTool(tool)}
                  className="accent-primary"
                />
                {tool}
              </label>
            ))}
          </div>
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Permission Mode
          </label>
          <RichSelect
            value={form.permission_mode}
            onChange={(v) => update("permission_mode", v)}
            options={[
              { value: "bypassPermissions", label: "bypassPermissions", description: "Skip all permission prompts" },
              { value: "default", label: "default", description: "Prompt for dangerous operations" },
            ]}
          />
        </div>
        {!isEdit && (
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
              Scope
            </label>
            <RichSelect
              value={form.scope}
              onChange={(v) => update("scope", v)}
              options={[
                { value: "project", label: "project", description: "Available only in this project" },
                { value: "global", label: "global", description: "Available across all projects" },
              ]}
            />
          </div>
        )}
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            System Prompt
          </label>
          <textarea
            className="min-h-[200px] w-full resize-y bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
            value={form.system_prompt}
            onChange={(e) => update("system_prompt", e.target.value)}
            placeholder="Optional system prompt for the agent..."
          />
        </div>
        <div className="flex gap-2 pt-4 border-t border-border mt-auto">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm">
            {isEdit ? "Save Agent" : "Create Agent"}
          </Button>
        </div>
      </form>
    </div>
  );
}
