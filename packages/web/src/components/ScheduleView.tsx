import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useSchedulesQuery } from "../hooks/useQueries.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Card } from "./ui/card.js";
import { Separator } from "./ui/separator.js";
import { Calendar } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";

interface ScheduleViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
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
        {/* Right: detail panel */}
        <div className="p-5 overflow-y-auto bg-background">
          {selected ? (
            <>
              <h2 className="text-lg font-semibold text-foreground mb-1">{selected.summary || selected.id}</h2>
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Schedule</h3>
                <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                  <span className="text-muted-foreground">ID</span>
                  <span className="text-card-foreground font-mono">{selected.id}</span>
                  <span className="text-muted-foreground">Cron</span>
                  <span className="text-card-foreground font-mono">{selected.cron}</span>
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
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Select a schedule
            </div>
          )}
        </div>
      </div>
      {showCreate && <NewScheduleModal onClose={() => onCloseCreate?.()} onSubmit={handleCreate} />}
    </>
  );
}

function NewScheduleModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (form: any) => void }) {
  const [form, setForm] = useState({
    cron: "",
    flow: "",
    repo: ".",
    summary: "",
    compute_name: "",
    group_name: "",
  });

  function update(key: string, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.cron.trim()) return;
    onSubmit(form);
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[90vw] bg-card border border-border rounded-xl p-6 z-[200] shadow-2xl">
          <form onSubmit={handleSubmit}>
            <Dialog.Title className="text-base font-semibold text-foreground mb-5">
              New Schedule
            </Dialog.Title>
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
              <Input value={form.flow} onChange={(e) => update("flow", e.target.value)} placeholder="bare" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Repository</label>
              <Input value={form.repo} onChange={(e) => update("repo", e.target.value)} placeholder="/path/to/repo or ." />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Compute</label>
              <Input value={form.compute_name} onChange={(e) => update("compute_name", e.target.value)} placeholder="Optional compute target" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Group</label>
              <Input value={form.group_name} onChange={(e) => update("group_name", e.target.value)} placeholder="Optional group name" />
            </div>
            <Separator className="mt-5" />
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
                Create Schedule
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
