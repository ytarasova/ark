import { useState, useEffect, type FormEvent } from "react";
import { api } from "../hooks/useApi.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { selectClassName } from "./ui/styles.js";
import { FolderPickerModal } from "./FolderPickerModal.js";

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
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    api.getAgents().then(setAgents).catch(() => {});
    api.getFlows().then(setFlows).catch(() => {});
    api.getCompute().then(setComputes).catch(() => {});
    api.getGroups().then(setGroups).catch(() => {});
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
    <div className="flex flex-col h-full p-5 overflow-y-auto">
      <h2 className="text-base font-semibold text-foreground mb-5">New Session</h2>
      <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
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
            <div className="flex items-center gap-2">
              <Input
                value={form.repo}
                onChange={(e) => update("repo", e.target.value)}
                placeholder="/path/to/repo or ."
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPickerOpen(true)}
              >
                Browse…
              </Button>
            </div>
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
              <option value="">(auto)</option>
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

          <div className="flex gap-2 pt-4 border-t border-border mt-auto">
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
      {pickerOpen && (
        <FolderPickerModal
          initialPath={form.repo && form.repo !== "." ? form.repo : undefined}
          onSelect={(path) => {
            update("repo", path);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
