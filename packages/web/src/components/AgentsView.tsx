import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useAgentsQuery } from "../hooks/useQueries.js";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Settings } from "lucide-react";

const selectClassName =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring appearance-none pr-8 bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_0.75rem_center]";

const TOOL_OPTIONS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch"];

function AgentForm({ onClose, onSubmit, agent, isEdit }: { onClose: () => void; onSubmit: (form: any) => void; agent?: any; isEdit?: boolean }) {
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
      <h2 className="text-base font-semibold text-foreground mb-5">{isEdit ? `Edit Agent: ${agent?.name}` : "New Agent"}</h2>
      <form onSubmit={handleSubmit} className="flex flex-col">
        {!isEdit && (
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Name *</label>
            <Input autoFocus value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="my-agent" />
          </div>
        )}
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Description</label>
          <Input value={form.description} onChange={(e) => update("description", e.target.value)} placeholder="What does this agent do?" />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Model</label>
          <select className={selectClassName} value={form.model} onChange={(e) => update("model", e.target.value)}>
            <option value="opus">opus</option>
            <option value="sonnet">sonnet</option>
            <option value="haiku">haiku</option>
          </select>
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Runtime</label>
          <select className={selectClassName} value={form.runtime} onChange={(e) => update("runtime", e.target.value)}>
            <option value="claude-code">claude-code</option>
            <option value="cli-agent">cli-agent</option>
          </select>
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Max Turns</label>
          <Input value={form.max_turns} onChange={(e) => update("max_turns", e.target.value)} placeholder="200" />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Tools</label>
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
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Permission Mode</label>
          <select className={selectClassName} value={form.permission_mode} onChange={(e) => update("permission_mode", e.target.value)}>
            <option value="bypassPermissions">bypassPermissions</option>
            <option value="default">default</option>
          </select>
        </div>
        {!isEdit && (
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Scope</label>
            <select className={selectClassName} value={form.scope} onChange={(e) => update("scope", e.target.value)}>
              <option value="project">project</option>
              <option value="global">global</option>
            </select>
          </div>
        )}
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">System Prompt</label>
          <textarea
            className="min-h-[200px] w-full resize-y bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
            value={form.system_prompt}
            onChange={(e) => update("system_prompt", e.target.value)}
            placeholder="Optional system prompt for the agent..."
          />
        </div>
        <div className="flex gap-2 pt-4 border-t border-border mt-auto">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm">{isEdit ? "Save Agent" : "Create Agent"}</Button>
        </div>
      </form>
    </div>
  );
}

interface AgentsViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
}

export function AgentsView({ showCreate = false, onCloseCreate }: AgentsViewProps) {
  const queryClient = useQueryClient();
  const { data: agents = [] } = useAgentsQuery();
  const [selected, setSelected] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);

  async function handleCreate(form: any) {
    try {
      await api.createAgent(form);
      onCloseCreate?.();
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch {}
  }

  async function handleUpdate(form: any) {
    try {
      await api.updateAgent(editing.name, form);
      setEditing(null);
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch {}
  }

  async function handleDelete(name: string) {
    try {
      await api.deleteAgent(name);
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch {}
  }

  if (!agents.length && !showCreate) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <Settings size={28} className="text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No custom agents. Builtin agents are shown by default.</p>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      {/* Left: list panel */}
      <div className="border-r border-border overflow-y-auto">
        {agents.map((a: any) => (
          <div
            key={a.name}
            className={cn(
              "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
              "hover:bg-accent",
              selected?.name === a.name && "bg-accent border-l-2 border-l-primary font-semibold"
            )}
            onClick={() => setSelected(a)}
          >
            <span className="text-foreground truncate">{a.name}</span>
            <Badge variant="secondary" className="text-[10px]">{a.source || "builtin"}</Badge>
          </div>
        ))}
      </div>
      {/* Right: detail panel or create form */}
      <div className="overflow-y-auto bg-background">
        {showCreate ? (
          <AgentForm onClose={() => onCloseCreate?.()} onSubmit={handleCreate} />
        ) : editing ? (
          <AgentForm onClose={() => setEditing(null)} onSubmit={handleUpdate} agent={editing} isEdit />
        ) : selected ? (
          <div className="p-5">
            <h2 className="text-lg font-semibold text-foreground mb-1">{selected.name}</h2>
            {selected.description && (
              <p className="text-sm text-muted-foreground mb-5">{selected.description}</p>
            )}
            <div className="mb-4">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Configuration</h3>
              <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                <span className="text-muted-foreground">Model</span>
                <span className="text-card-foreground font-mono">{selected.model || "-"}</span>
                <span className="text-muted-foreground">Max Turns</span>
                <span className="text-card-foreground font-mono">{selected.max_turns ?? "-"}</span>
                <span className="text-muted-foreground">Permission</span>
                <span className="text-card-foreground font-mono">{selected.permission_mode || "-"}</span>
                <span className="text-muted-foreground">Runtime</span>
                <span className="text-card-foreground font-mono">{selected.runtime || "claude-code"}</span>
              </div>
            </div>
            {selected.skills && selected.skills.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Skills</h3>
                <div className="flex flex-wrap gap-1.5">
                  {selected.skills.map((s: string) => (
                    <Badge key={s} variant="default" className="text-[11px]">{s}</Badge>
                  ))}
                </div>
              </div>
            )}
            {selected.tools && selected.tools.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Tools</h3>
                <div className="flex flex-wrap gap-1.5">
                  {selected.tools.map((t: string) => (
                    <Badge key={t} variant="secondary" className="text-[11px]">{t}</Badge>
                  ))}
                </div>
              </div>
            )}
            {selected.mcp_servers && selected.mcp_servers.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">MCP Servers</h3>
                <div className="flex flex-wrap gap-1.5">
                  {selected.mcp_servers.map((m: string) => (
                    <Badge key={m} variant="secondary" className="text-[11px]">{m}</Badge>
                  ))}
                </div>
              </div>
            )}
            {selected.system_prompt && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">System Prompt</h3>
                <div className="bg-black/40 border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground">{selected.system_prompt}</div>
              </div>
            )}
            {selected._source !== "builtin" && (
              <div className="mt-5 flex gap-1.5">
                <Button variant="outline" size="xs" onClick={() => setEditing(selected)}>
                  Edit Agent
                </Button>
                <Button variant="destructive" size="xs" onClick={() => handleDelete(selected.name)}>
                  Delete Agent
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select an agent
          </div>
        )}
      </div>
    </div>
    </>
  );
}
