import { useState, useEffect, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Separator } from "./ui/separator.js";

interface NewSessionModalProps {
  onClose: () => void;
  onSubmit: (form: {
    summary: string;
    repo: string;
    flow: string;
    group_name: string;
    ticket: string;
    compute_name: string;
    agent: string;
    dispatch: boolean;
  }) => void;
}

const selectClassName =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function NewSessionModal({ onClose, onSubmit }: NewSessionModalProps) {
  const [form, setForm] = useState({
    summary: "",
    repo: ".",
    ticket: "",
    flow: "",
    agent: "",
    compute_name: "",
    group_name: "",
    dispatch: false,
  });

  const [agents, setAgents] = useState<{ name: string }[]>([]);
  const [flows, setFlows] = useState<{ name: string }[]>([]);
  const [computes, setComputes] = useState<{ name: string }[]>([]);
  const [groups, setGroups] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/agents").then(r => r.json()).then(setAgents).catch(() => {});
    fetch("/api/flows").then(r => r.json()).then(setFlows).catch(() => {});
    fetch("/api/compute").then(r => r.json()).then(setComputes).catch(() => {});
    fetch("/api/groups").then(r => r.json()).then(setGroups).catch(() => {});
  }, []);

  function update(key: string, val: string | boolean) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.summary.trim()) return;
    onSubmit(form);
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-w-[90vw] bg-card border border-border rounded-xl p-6 z-[200] shadow-2xl">
          <form onSubmit={handleSubmit}>
            <Dialog.Title className="text-base font-semibold text-foreground mb-5">
              New Session
            </Dialog.Title>

            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Summary *</label>
              <Input
                autoFocus
                value={form.summary}
                onChange={(e) => update("summary", e.target.value)}
                placeholder="What should the agent work on?"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Repository</label>
              <Input
                value={form.repo}
                onChange={(e) => update("repo", e.target.value)}
                placeholder="/path/to/repo or ."
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Ticket</label>
              <Input
                value={form.ticket}
                onChange={(e) => update("ticket", e.target.value)}
                placeholder="Jira key, GitHub issue, etc."
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Flow</label>
              <select
                className={selectClassName}
                value={form.flow}
                onChange={(e) => update("flow", e.target.value)}
              >
                <option value="">default</option>
                {flows.map((f) => (
                  <option key={f.name} value={f.name}>{f.name}</option>
                ))}
              </select>
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Agent</label>
              <select
                className={selectClassName}
                value={form.agent}
                onChange={(e) => update("agent", e.target.value)}
              >
                <option value="">auto</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Compute</label>
              <select
                className={selectClassName}
                value={form.compute_name}
                onChange={(e) => update("compute_name", e.target.value)}
              >
                <option value="">local</option>
                {computes.map((c) => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Group</label>
              {groups.length > 0 && (
                <select
                  className={selectClassName}
                  value={groups.includes(form.group_name) ? form.group_name : ""}
                  onChange={(e) => update("group_name", e.target.value)}
                >
                  <option value="">none</option>
                  {groups.map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              )}
              <Input
                className={groups.length > 0 ? "mt-1.5" : ""}
                value={form.group_name}
                onChange={(e) => update("group_name", e.target.value)}
                placeholder="Or type a new group name"
              />
            </div>

            <div className="mb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.dispatch}
                  onChange={(e) => update("dispatch", e.target.checked)}
                  className="rounded border-input"
                />
                <span className="text-sm text-foreground">Dispatch after creation</span>
              </label>
            </div>

            <Separator className="mt-4" />
            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
              >
                Create Session
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
