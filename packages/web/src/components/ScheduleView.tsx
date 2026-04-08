import { useState, useEffect, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useSchedulesQuery } from "../hooks/useQueries.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Calendar } from "lucide-react";

interface ScheduleViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
}

function describeCron(cron: string): string {
  if (!cron) return "";
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [minute, hour, dom, month, dow] = parts;

  // Common patterns
  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "Every minute";
  if (minute.startsWith("*/") && hour === "*" && dom === "*" && month === "*" && dow === "*") return `Every ${minute.slice(2)} minutes`;
  if (hour.startsWith("*/") && dom === "*" && month === "*" && dow === "*") return `Every ${hour.slice(2)} hours at minute ${minute}`;
  if (minute !== "*" && hour !== "*" && dom === "*" && month === "*" && dow === "*") return `Daily at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (minute !== "*" && hour !== "*" && dom === "*" && month === "*" && dow !== "*") {
    const days: Record<string, string> = { "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat", "7": "Sun" };
    const dayList = dow.split(",").map(d => days[d] || d).join(", ");
    return `${dayList} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }
  if (minute !== "*" && hour !== "*" && dom !== "*" && month === "*" && dow === "*") return `Monthly on day ${dom} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  return cron;
}

export function ScheduleView({ showCreate = false, onCloseCreate }: ScheduleViewProps) {
  const queryClient = useQueryClient();
  const { data: schedules = [] } = useSchedulesQuery();
  const [selected, setSelected] = useState<any>(null);

  async function handleToggle(sched: any) {
    if (sched.enabled) {
      await api.disableSchedule(sched.id);
    } else {
      await api.enableSchedule(sched.id);
    }
    queryClient.invalidateQueries({ queryKey: ["schedules"] });
  }

  async function handleDelete(sched: any) {
    await api.deleteSchedule(sched.id);
    setSelected(null);
    queryClient.invalidateQueries({ queryKey: ["schedules"] });
  }

  async function handleCreate(form: any) {
    await api.createSchedule(form);
    onCloseCreate?.();
    queryClient.invalidateQueries({ queryKey: ["schedules"] });
  }

  if (!schedules.length && !showCreate) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <Calendar size={28} className="text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No schedules</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
        {/* Left: list panel */}
        <div className="bg-card border-r border-border overflow-y-auto">
          {schedules.map((s: any) => (
            <div
              key={s.id}
              className={cn(
                "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                "hover:bg-accent",
                selected?.id === s.id && "bg-accent border-l-2 border-l-primary font-semibold"
              )}
              onClick={() => setSelected(s)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", s.enabled ? "bg-emerald-400" : "bg-muted-foreground/30")} />
                <span className="text-foreground truncate">{s.summary || s.id}</span>
              </div>
              <span className="text-[10px] font-mono uppercase text-muted-foreground tracking-wider shrink-0 ml-2">{s.cron}</span>
            </div>
          ))}
        </div>
        {/* Right: detail panel or create form */}
        <div className="overflow-y-auto bg-background">
          {showCreate ? (
            <NewScheduleForm onClose={() => onCloseCreate?.()} onSubmit={handleCreate} />
          ) : selected ? (
            <div className="p-5">
              <h2 className="text-lg font-semibold text-foreground mb-1">{selected.summary || selected.id}</h2>
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Schedule</h3>
                <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                  <span className="text-muted-foreground">ID</span>
                  <span className="text-card-foreground font-mono">{selected.id}</span>
                  <span className="text-muted-foreground">Cron</span>
                  <span className="text-card-foreground font-mono">{selected.cron}</span>
                  {selected.cron && describeCron(selected.cron) !== selected.cron && (
                    <>
                      <span className="text-muted-foreground">Schedule</span>
                      <span className="text-card-foreground">{describeCron(selected.cron)}</span>
                    </>
                  )}
                  <span className="text-muted-foreground">Status</span>
                  <span className="text-card-foreground flex items-center gap-2">
                    <span className={cn("inline-block w-2 h-2 rounded-full", selected.enabled ? "bg-emerald-400" : "bg-muted-foreground/30")} />
                    {selected.enabled ? "Enabled" : "Disabled"}
                  </span>
                  <span className="text-muted-foreground">Flow</span>
                  <span className="text-card-foreground">{selected.flow || "bare"}</span>
                  {selected.repo && (
                    <>
                      <span className="text-muted-foreground">Repo</span>
                      <span className="text-card-foreground font-mono">{selected.repo}</span>
                    </>
                  )}
                  {selected.compute_name && (
                    <>
                      <span className="text-muted-foreground">Compute</span>
                      <span className="text-card-foreground">{selected.compute_name}</span>
                    </>
                  )}
                  {selected.group_name && (
                    <>
                      <span className="text-muted-foreground">Group</span>
                      <span className="text-card-foreground">{selected.group_name}</span>
                    </>
                  )}
                  {selected.last_run && (
                    <>
                      <span className="text-muted-foreground">Last Run</span>
                      <span className="text-card-foreground">{new Date(selected.last_run).toLocaleString()}</span>
                    </>
                  )}
                  {selected.created_at && (
                    <>
                      <span className="text-muted-foreground">Created</span>
                      <span className="text-card-foreground">{new Date(selected.created_at).toLocaleString()}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Actions</h3>
                <div className="flex gap-1.5 flex-wrap">
                  <Button variant="outline" size="xs" onClick={() => handleToggle(selected)}>
                    {selected.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="destructive" size="xs" onClick={() => handleDelete(selected)}>
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Select a schedule
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const selectClassName =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring appearance-none pr-8 bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_0.75rem_center]";

function NewScheduleForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (form: any) => void }) {
  const [form, setForm] = useState({
    cron: "",
    flow: "",
    repo: ".",
    summary: "",
    compute_name: "",
    group_name: "",
  });

  const [flows, setFlows] = useState<{ name: string }[]>([]);
  const [computes, setComputes] = useState<{ name: string }[]>([]);
  const [groups, setGroups] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/flows").then(r => r.json()).then(setFlows).catch(() => {});
    fetch("/api/compute").then(r => r.json()).then(setComputes).catch(() => {});
    fetch("/api/groups").then(r => r.json()).then(setGroups).catch(() => {});
  }, []);

  function update(key: string, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.cron.trim()) return;
    onSubmit(form);
  }

  return (
    <div className="flex flex-col h-full p-5 overflow-y-auto">
      <h2 className="text-base font-semibold text-foreground mb-5">New Schedule</h2>
      <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Cron Expression *</label>
          <Input autoFocus value={form.cron} onChange={(e) => update("cron", e.target.value)} placeholder="*/30 * * * *" />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Summary</label>
          <Input value={form.summary} onChange={(e) => update("summary", e.target.value)} placeholder="What should the scheduled agent do?" />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Flow</label>
          <select className={selectClassName} value={form.flow} onChange={(e) => update("flow", e.target.value)}>
            {flows.map((f) => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
          </select>
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Repository</label>
          <Input value={form.repo} onChange={(e) => update("repo", e.target.value)} placeholder="/path/to/repo or ." />
        </div>
        <div className="mb-3.5">
          <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Compute</label>
          <select className={selectClassName} value={form.compute_name} onChange={(e) => update("compute_name", e.target.value)}>
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
        <div className="flex gap-2 pt-4 border-t border-border mt-auto">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm">Create Schedule</Button>
        </div>
      </form>
    </div>
  );
}
