import React, { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useAgentsQuery } from "../hooks/useAgentQueries.js";
import { useRuntimesQuery } from "../hooks/useRuntimeQueries.js";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Settings } from "lucide-react";
import { selectClassName } from "./ui/styles.js";

const TOOL_OPTIONS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch"];

function AgentForm({
  onClose,
  onSubmit,
  agent,
  isEdit,
  runtimes = [],
}: {
  onClose: () => void;
  onSubmit: (form: any) => void;
  agent?: any;
  isEdit?: boolean;
  runtimes?: any[];
}) {
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
          <Input
            list="model-suggestions"
            value={form.model}
            onChange={(e) => update("model", e.target.value)}
            placeholder="e.g. sonnet, opus, claude-sonnet-4-6"
          />
          <datalist id="model-suggestions">
            <option value="opus" />
            <option value="sonnet" />
            <option value="haiku" />
            {runtimes
              .flatMap((r: any) => (r.models || []).map((m: any) => m.id))
              .filter(
                (id: string, i: number, arr: string[]) =>
                  arr.indexOf(id) === i && !["opus", "sonnet", "haiku"].includes(id),
              )
              .map((id: string) => (
                <option key={id} value={id} />
              ))}
          </datalist>
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
            Runtime
          </label>
          <select className={selectClassName} value={form.runtime} onChange={(e) => update("runtime", e.target.value)}>
            {runtimes.length > 0 ? (
              runtimes.map((r: any) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))
            ) : (
              <>
                <option value="claude-code">claude-code</option>
                <option value="cli-agent">cli-agent</option>
              </>
            )}
          </select>
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
          <select
            className={selectClassName}
            value={form.permission_mode}
            onChange={(e) => update("permission_mode", e.target.value)}
          >
            <option value="bypassPermissions">bypassPermissions</option>
            <option value="default">default</option>
          </select>
        </div>
        {!isEdit && (
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
              Scope
            </label>
            <select className={selectClassName} value={form.scope} onChange={(e) => update("scope", e.target.value)}>
              <option value="project">project</option>
              <option value="global">global</option>
            </select>
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

// ── Sub-tab selector ───────────────────────────────────────────────────────

type SubTab = "roles" | "runtimes";

function SubTabBar({ active, onChange }: { active: SubTab; onChange: (tab: SubTab) => void }) {
  const tabs: { id: SubTab; label: string }[] = [
    { id: "roles", label: "Roles" },
    { id: "runtimes", label: "Runtimes" },
  ];

  return (
    <div className="flex border-b border-border px-4 shrink-0">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "px-3 py-2 text-[13px] font-medium transition-colors border-b-2 -mb-px",
            active === t.id
              ? "text-foreground border-primary"
              : "text-muted-foreground border-transparent hover:text-foreground hover:border-border",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

interface AgentsViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
  initialSelectedName?: string | null;
  onSelectedChange?: (name: string | null) => void;
}

export function AgentsView({
  showCreate = false,
  onCloseCreate,
  initialSelectedName,
  onSelectedChange,
}: AgentsViewProps) {
  const queryClient = useQueryClient();
  const { data: agents = [] } = useAgentsQuery();
  const { data: runtimes = [] } = useRuntimesQuery();
  const [subTab, setSubTab] = useState<SubTab>("roles");
  const [selectedInternal, setSelectedInternal] = useState<any>(null);
  const selected =
    selectedInternal ?? (initialSelectedName ? agents.find((a: any) => a.name === initialSelectedName) : null);
  const setSelected = (item: any) => {
    setSelectedInternal(item);
    onSelectedChange?.(item?.name ?? null);
  };
  const [editing, setEditing] = useState<any>(null);

  const [actionMsg, setActionMsg] = useState<{ text: string; type: string } | null>(null);

  function showActionMsg(text: string, type: string) {
    setActionMsg({ text, type });
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function handleCreate(form: any) {
    try {
      await api.createAgent(form);
      onCloseCreate?.();
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (err: any) {
      showActionMsg(err.message || "Failed to create agent", "error");
    }
  }

  async function handleUpdate(form: any) {
    try {
      await api.updateAgent(editing.name, form);
      setEditing(null);
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (err: any) {
      showActionMsg(err.message || "Failed to update agent", "error");
    }
  }

  async function handleDelete(name: string) {
    try {
      await api.deleteAgent(name);
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (err: any) {
      showActionMsg(err.message || "Failed to delete agent", "error");
    }
  }

  // Clear selection when switching tabs
  function handleTabChange(tab: SubTab) {
    setSubTab(tab);
    setSelected(null);
    setEditing(null);
  }

  const isEmpty = subTab === "roles" ? agents.length === 0 : runtimes.length === 0;

  if (isEmpty && !showCreate) {
    return (
      <div className="flex flex-col h-full">
        <SubTabBar active={subTab} onChange={handleTabChange} />
        <div className="flex items-center justify-center flex-1">
          <div className="text-center">
            <Settings size={28} className="text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {subTab === "roles" ? "No custom agents. Builtin agents are shown by default." : "No runtimes found."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden h-full">
      <SubTabBar active={subTab} onChange={handleTabChange} />
      <div className="grid grid-cols-[260px_1fr] overflow-hidden flex-1">
        {/* Left: list panel */}
        <div className="border-r border-border overflow-y-auto">
          {subTab === "roles"
            ? agents.map((a: any) => (
                <div
                  key={a.name}
                  className={cn(
                    "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                    "hover:bg-accent",
                    selected?.name === a.name &&
                      selected?._kind === "role" &&
                      "bg-accent border-l-2 border-l-primary font-semibold",
                  )}
                  onClick={() => setSelected({ ...a, _kind: "role" })}
                >
                  <div className="flex flex-col min-w-0 mr-2">
                    <span className="text-foreground truncate">{a.name}</span>
                    <span className="text-[11px] text-muted-foreground truncate">
                      {a.runtime || "claude"} / {a.model}
                    </span>
                  </div>
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {a.source || "builtin"}
                  </Badge>
                </div>
              ))
            : runtimes.map((r: any) => (
                <div
                  key={r.name}
                  className={cn(
                    "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                    "hover:bg-accent",
                    selected?.name === r.name &&
                      selected?._kind === "runtime" &&
                      "bg-accent border-l-2 border-l-primary font-semibold",
                  )}
                  onClick={() => setSelected({ ...r, _kind: "runtime" })}
                >
                  <div className="flex flex-col min-w-0 mr-2">
                    <span className="text-foreground truncate">{r.name}</span>
                    <span className="text-[11px] text-muted-foreground truncate">
                      {r.type} / {r.default_model || "-"}
                    </span>
                  </div>
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {r._source || "builtin"}
                  </Badge>
                </div>
              ))}
        </div>

        {/* Right: detail panel or create form */}
        <div className="overflow-y-auto bg-background">
          {showCreate ? (
            <AgentForm onClose={() => onCloseCreate?.()} onSubmit={handleCreate} runtimes={runtimes} />
          ) : editing ? (
            <AgentForm
              onClose={() => setEditing(null)}
              onSubmit={handleUpdate}
              agent={editing}
              isEdit
              runtimes={runtimes}
            />
          ) : selected?._kind === "role" ? (
            <RoleDetail
              agent={selected}
              onEdit={() => setEditing(selected)}
              onDelete={() => handleDelete(selected.name)}
              actionMsg={actionMsg}
            />
          ) : selected?._kind === "runtime" ? (
            <RuntimeDetail runtime={selected} />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {subTab === "roles" ? "Select an agent" : "Select a runtime"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Role Detail ────────────────────────────────────────────────────────────

function RoleDetail({
  agent,
  onEdit,
  onDelete,
  actionMsg,
}: {
  agent: any;
  onEdit: () => void;
  onDelete: () => void;
  actionMsg: { text: string; type: string } | null;
}) {
  return (
    <div className="p-5">
      <h2 className="text-lg font-semibold text-foreground mb-1">{agent.name}</h2>
      {agent.description && <p className="text-sm text-muted-foreground mb-5">{agent.description}</p>}
      <div className="mb-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
          Configuration
        </h3>
        <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
          <span className="text-muted-foreground">Model</span>
          <span className="text-card-foreground font-mono">{agent.model || "-"}</span>
          <span className="text-muted-foreground">Max Turns</span>
          <span className="text-card-foreground font-mono">{agent.max_turns ?? "-"}</span>
          <span className="text-muted-foreground">Permission</span>
          <span className="text-card-foreground font-mono">{agent.permission_mode || "-"}</span>
          <span className="text-muted-foreground">Runtime</span>
          <span className="text-card-foreground font-mono">{agent.runtime || "claude-code"}</span>
        </div>
      </div>
      {agent.skills && agent.skills.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Skills</h3>
          <div className="flex flex-wrap gap-1.5">
            {agent.skills.map((s: string) => (
              <Badge key={s} variant="default" className="text-[11px]">
                {s}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {agent.tools && agent.tools.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Tools</h3>
          <div className="flex flex-wrap gap-1.5">
            {agent.tools.map((t: string) => (
              <Badge key={t} variant="secondary" className="text-[11px]">
                {t}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {agent.mcp_servers && agent.mcp_servers.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            MCP Servers
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {agent.mcp_servers.map((m: string) => (
              <Badge key={m} variant="secondary" className="text-[11px]">
                {m}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {agent.system_prompt && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            System Prompt
          </h3>
          <div className="bg-black/40 border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground">
            {agent.system_prompt}
          </div>
        </div>
      )}
      {agent._source !== "builtin" && (
        <div className="mt-5 flex gap-1.5">
          <Button variant="outline" size="xs" onClick={onEdit}>
            Edit Agent
          </Button>
          <Button variant="destructive" size="xs" onClick={onDelete}>
            Delete Agent
          </Button>
        </div>
      )}
      {actionMsg && (
        <div className={cn("mt-1.5 text-xs", actionMsg.type === "error" ? "text-red-400" : "text-emerald-400")}>
          {actionMsg.text}
        </div>
      )}
    </div>
  );
}

// ── Runtime Detail ─────────────────────────────────────────────────────────

function RuntimeDetail({ runtime }: { runtime: any }) {
  return (
    <div className="p-5">
      <h2 className="text-lg font-semibold text-foreground mb-1">{runtime.name}</h2>
      {runtime.description && <p className="text-sm text-muted-foreground mb-5">{runtime.description}</p>}
      <div className="mb-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
          Configuration
        </h3>
        <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
          <span className="text-muted-foreground">Type</span>
          <span className="text-card-foreground font-mono">{runtime.type || "-"}</span>
          <span className="text-muted-foreground">Default Model</span>
          <span className="text-card-foreground font-mono">{runtime.default_model || "-"}</span>
          <span className="text-muted-foreground">Source</span>
          <span className="text-card-foreground font-mono">{runtime._source || "builtin"}</span>
          {runtime.permission_mode && (
            <>
              <span className="text-muted-foreground">Permission</span>
              <span className="text-card-foreground font-mono">{runtime.permission_mode}</span>
            </>
          )}
          {runtime.task_delivery && (
            <>
              <span className="text-muted-foreground">Task Delivery</span>
              <span className="text-card-foreground font-mono">{runtime.task_delivery}</span>
            </>
          )}
        </div>
      </div>

      {runtime.command && runtime.command.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Command</h3>
          <div className="bg-black/40 border border-border rounded-lg px-3.5 py-2.5 font-mono text-[12px] text-muted-foreground">
            {runtime.command.join(" ")}
          </div>
        </div>
      )}

      {runtime.models && runtime.models.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            Models ({runtime.models.length})
          </h3>
          <div className="grid grid-cols-[100px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
            {runtime.models.map((m: any) => (
              <React.Fragment key={m.id}>
                <span className="text-card-foreground font-mono">{m.id}</span>
                <span className="text-muted-foreground">{m.label}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {runtime.env && Object.keys(runtime.env).length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            Environment
          </h3>
          <div className="bg-black/40 border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] text-muted-foreground">
            {Object.entries(runtime.env).map(([k, v]) => (
              <div key={k}>
                {k}={String(v)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
