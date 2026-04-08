import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useAgentsQuery } from "../hooks/useQueries.js";
import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Separator } from "./ui/separator.js";
import { Settings } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";

function NewAgentModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (form: any) => void }) {
  const [form, setForm] = useState({ name: "", description: "", model: "sonnet", runtime: "claude-code" });

  function update(key: string, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSubmit(form);
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[90vw] bg-card border border-border rounded-xl p-6 z-[200] shadow-2xl">
          <form onSubmit={handleSubmit}>
            <Dialog.Title className="text-base font-semibold text-foreground mb-5">
              New Agent
            </Dialog.Title>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Name *</label>
              <Input autoFocus value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="my-agent" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Description</label>
              <Input value={form.description} onChange={(e) => update("description", e.target.value)} placeholder="What does this agent do?" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Model</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring appearance-none pr-8 bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_0.75rem_center]"
                value={form.model}
                onChange={(e) => update("model", e.target.value)}
              >
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
              </select>
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Runtime</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring appearance-none pr-8 bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_0.75rem_center]"
                value={form.runtime}
                onChange={(e) => update("runtime", e.target.value)}
              >
                <option value="claude-code">claude-code</option>
                <option value="subprocess">subprocess</option>
              </select>
            </div>
            <Separator className="mt-5" />
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button type="submit" size="sm">Create Agent</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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

  async function handleCreate(form: any) {
    try {
      await api.createAgent(form);
      onCloseCreate?.();
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
      <div className="bg-card border-r border-border overflow-y-auto">
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
      {/* Right: detail panel */}
      <div className="p-5 overflow-y-auto bg-background">
        {selected ? (
          <>
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
            {selected.source !== "builtin" && (
              <div className="mt-5">
                <Button variant="destructive" size="xs" onClick={() => handleDelete(selected.name)}>
                  Delete Agent
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select an agent
          </div>
        )}
      </div>
    </div>
    {showCreate && <NewAgentModal onClose={() => onCloseCreate?.()} onSubmit={handleCreate} />}
    </>
  );
}
