import { useState, useEffect, type FormEvent } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Calendar } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";

const btnClass = "px-3 py-1 text-xs font-medium rounded-md border border-white/[0.06] text-white/50 hover:text-white/80 hover:border-white/[0.1] transition-colors";
const btnDanger = "px-3 py-1 text-xs font-medium rounded-md border border-red-500/20 text-red-400/70 hover:text-red-400 hover:border-red-500/30 transition-colors";
const btnPrimary = "px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-500 border border-indigo-500/50 text-white hover:bg-indigo-400 transition-colors";
const inputClass = "w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 text-[13px] text-white/90 placeholder:text-white/25 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 outline-none transition-all";

export function ScheduleView() {
  const [schedules, setSchedules] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [showNew, setShowNew] = useState(false);

  function load() {
    api.getSchedules().then((data) => {
      const list = data || [];
      setSchedules(list);
      if (selected) {
        const updated = list.find((s: any) => s.id === selected.id);
        setSelected(updated || (list.length ? list[0] : null));
      } else if (list.length) {
        setSelected(list[0]);
      }
    });
  }

  useEffect(() => { load(); }, []);

  async function handleToggle(sched: any) {
    if (sched.enabled) {
      await api.disableSchedule(sched.id);
    } else {
      await api.enableSchedule(sched.id);
    }
    load();
  }

  async function handleDelete(sched: any) {
    await api.deleteSchedule(sched.id);
    setSelected(null);
    load();
  }

  async function handleCreate(form: any) {
    await api.createSchedule(form);
    setShowNew(false);
    load();
  }

  if (!schedules.length && !showNew) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <Calendar size={28} className="text-white/15 mx-auto mb-3" />
          <p className="text-sm text-white/35 mb-4">No schedules</p>
          <button className={btnPrimary} onClick={() => setShowNew(true)}>
            New Schedule
          </button>
          {showNew && <NewScheduleModal onClose={() => setShowNew(false)} onSubmit={handleCreate} />}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-[260px_1fr] rounded-lg border border-white/[0.06] overflow-hidden h-[calc(100vh-112px)]">
        {/* Left: list panel */}
        <div className="bg-white/[0.02] border-r border-white/[0.06] overflow-y-auto">
          <div className="p-2 px-3">
            <button className={cn(btnPrimary, "w-full")} onClick={() => setShowNew(true)}>
              + New Schedule
            </button>
          </div>
          {schedules.map((s: any) => (
            <div
              key={s.id}
              className={cn(
                "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-white/[0.03] transition-colors text-[13px]",
                "hover:bg-white/[0.03]",
                selected?.id === s.id && "bg-white/[0.05] border-l-2 border-l-indigo-400 font-semibold"
              )}
              onClick={() => setSelected(s)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", s.enabled ? "bg-emerald-400" : "bg-white/20")} />
                <span className="text-white/80 truncate">{s.summary || s.id}</span>
              </div>
              <span className="text-[10px] font-mono uppercase text-white/25 tracking-wider shrink-0 ml-2">{s.cron}</span>
            </div>
          ))}
        </div>
        {/* Right: detail panel */}
        <div className="p-5 overflow-y-auto bg-[#0d0d11]">
          {selected ? (
            <>
              <h2 className="text-lg font-semibold text-white/90 mb-1">{selected.summary || selected.id}</h2>
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Schedule</h3>
                <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                  <span className="text-white/35">ID</span>
                  <span className="text-white/75 font-mono">{selected.id}</span>
                  <span className="text-white/35">Cron</span>
                  <span className="text-white/75 font-mono">{selected.cron}</span>
                  <span className="text-white/35">Status</span>
                  <span className="text-white/75 flex items-center gap-2">
                    <span className={cn("inline-block w-2 h-2 rounded-full", selected.enabled ? "bg-emerald-400" : "bg-white/20")} />
                    {selected.enabled ? "Enabled" : "Disabled"}
                  </span>
                  <span className="text-white/35">Flow</span>
                  <span className="text-white/75">{selected.flow || "bare"}</span>
                  {selected.repo && (
                    <>
                      <span className="text-white/35">Repo</span>
                      <span className="text-white/75 font-mono">{selected.repo}</span>
                    </>
                  )}
                  {selected.compute_name && (
                    <>
                      <span className="text-white/35">Compute</span>
                      <span className="text-white/75">{selected.compute_name}</span>
                    </>
                  )}
                  {selected.group_name && (
                    <>
                      <span className="text-white/35">Group</span>
                      <span className="text-white/75">{selected.group_name}</span>
                    </>
                  )}
                  {selected.last_run && (
                    <>
                      <span className="text-white/35">Last Run</span>
                      <span className="text-white/75">{new Date(selected.last_run).toLocaleString()}</span>
                    </>
                  )}
                  {selected.created_at && (
                    <>
                      <span className="text-white/35">Created</span>
                      <span className="text-white/75">{new Date(selected.created_at).toLocaleString()}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Actions</h3>
                <div className="flex gap-1.5 flex-wrap">
                  <button className={btnClass} onClick={() => handleToggle(selected)}>
                    {selected.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className={btnDanger} onClick={() => handleDelete(selected)}>
                    Delete
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-white/25">
              Select a schedule
            </div>
          )}
        </div>
      </div>
      {showNew && <NewScheduleModal onClose={() => setShowNew(false)} onSubmit={handleCreate} />}
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
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[90vw] bg-[#111116] border border-white/[0.08] rounded-xl p-6 z-[200] shadow-2xl">
          <form onSubmit={handleSubmit}>
            <Dialog.Title className="text-base font-semibold text-white/90 mb-5">
              New Schedule
            </Dialog.Title>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Cron Expression *</label>
              <input className={inputClass} autoFocus value={form.cron} onChange={(e) => update("cron", e.target.value)} placeholder="*/30 * * * *" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Summary</label>
              <input className={inputClass} value={form.summary} onChange={(e) => update("summary", e.target.value)} placeholder="What should the scheduled agent do?" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Flow</label>
              <input className={inputClass} value={form.flow} onChange={(e) => update("flow", e.target.value)} placeholder="bare" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Repository</label>
              <input className={inputClass} value={form.repo} onChange={(e) => update("repo", e.target.value)} placeholder="/path/to/repo or ." />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Compute</label>
              <input className={inputClass} value={form.compute_name} onChange={(e) => update("compute_name", e.target.value)} placeholder="Optional compute target" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Group</label>
              <input className={inputClass} value={form.group_name} onChange={(e) => update("group_name", e.target.value)} placeholder="Optional group name" />
            </div>
            <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-white/[0.06]">
              <button
                type="button"
                className={btnClass}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={btnPrimary}
              >
                Create Schedule
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
