import { useState, useEffect, type FormEvent } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import * as Dialog from "@radix-ui/react-dialog";

const btnBase = "glass-btn inline-flex items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium cursor-pointer text-label active:scale-[0.97] transition-all duration-200 whitespace-nowrap";
const btnPrimary = "bg-tint border-none text-white font-semibold shadow-[0_2px_12px_rgba(124,106,239,0.3),inset_0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110";
const btnDanger = "text-danger border-danger/20 bg-transparent hover:bg-danger-dim hover:border-danger/30";
const btnSm = "px-2.5 py-1 text-xs";
const inputBase = "w-full glass-input rounded-lg px-3 py-2 text-[13px] text-label placeholder:text-label-quaternary outline-none focus:border-tint focus:shadow-[0_0_0_3px_var(--color-tint-dim)] transition-all duration-200";

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
      <div className="text-center py-16 px-6 text-label-tertiary">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-15 mb-4 mx-auto">
          <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <div className="text-[13px] text-label-tertiary mb-3">No schedules</div>
        <button className={cn(btnBase, "px-3.5 py-[7px]", btnPrimary)} onClick={() => setShowNew(true)}>
          New Schedule
        </button>
        {showNew && <NewScheduleModal onClose={() => setShowNew(false)} onSubmit={handleCreate} />}
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-[260px_1fr] rounded-xl glass-card glass-shine-subtle overflow-hidden h-[calc(100vh-112px)] max-md:grid-cols-1">
        <div className="glass-surface bg-glass-dark border-r border-white/8 overflow-y-auto h-full">
          <div className="p-2 px-3">
            <button className={cn(btnBase, "w-full text-[11px] px-3.5 py-[7px]", btnPrimary)} onClick={() => setShowNew(true)}>
              + New Schedule
            </button>
          </div>
          {schedules.map((s: any) => (
            <div
              key={s.id}
              className={cn(
                "flex justify-between items-center px-3.5 py-2.5 cursor-pointer border-b border-white/4 hover:bg-white/5 transition-colors text-xs",
                selected?.id === s.id && "bg-white/12 border-l-3 border-l-tint font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
              )}
              onClick={() => setSelected(s)}
            >
              <div className="flex items-center gap-2">
                <span className={cn("inline-block w-2 h-2 rounded-full", s.enabled ? "bg-success" : "bg-label-quaternary")} />
                <div className="font-medium text-[13px] text-label">{s.summary || s.id}</div>
              </div>
              <span className="text-[10px] font-medium uppercase tracking-[0.03em] px-2 py-0.5 rounded-full bg-white/6 text-label-tertiary whitespace-nowrap font-mono backdrop-blur-[4px]">{s.cron}</span>
            </div>
          ))}
        </div>
        <div className="p-5 overflow-y-auto h-full bg-surface-0 bg-black/20 backdrop-blur-[20px] saturate-150">
          {selected ? (
            <>
              <h2 className="text-[15px] font-semibold text-label mb-1.5 tracking-[-0.01em]">{selected.summary || selected.id}</h2>
              <div className="mb-5">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Schedule</div>
                <div className="grid grid-cols-[100px_1fr] gap-x-3.5 gap-y-1.5 text-xs">
                  <div className="text-label-tertiary font-medium">ID</div>
                  <div className="text-label font-mono">{selected.id}</div>
                  <div className="text-label-tertiary font-medium">Cron</div>
                  <div className="text-label font-mono">{selected.cron}</div>
                  <div className="text-label-tertiary font-medium">Status</div>
                  <div className="text-label flex items-center gap-2">
                    <span className={cn("inline-block w-2 h-2 rounded-full", selected.enabled ? "bg-success" : "bg-label-quaternary")} />
                    {selected.enabled ? "Enabled" : "Disabled"}
                  </div>
                  <div className="text-label-tertiary font-medium">Flow</div>
                  <div className="text-label">{selected.flow || "bare"}</div>
                  {selected.repo && (
                    <>
                      <div className="text-label-tertiary font-medium">Repo</div>
                      <div className="text-label font-mono">{selected.repo}</div>
                    </>
                  )}
                  {selected.compute_name && (
                    <>
                      <div className="text-label-tertiary font-medium">Compute</div>
                      <div className="text-label">{selected.compute_name}</div>
                    </>
                  )}
                  {selected.group_name && (
                    <>
                      <div className="text-label-tertiary font-medium">Group</div>
                      <div className="text-label">{selected.group_name}</div>
                    </>
                  )}
                  {selected.last_run && (
                    <>
                      <div className="text-label-tertiary font-medium">Last Run</div>
                      <div className="text-label">{new Date(selected.last_run).toLocaleString()}</div>
                    </>
                  )}
                  {selected.created_at && (
                    <>
                      <div className="text-label-tertiary font-medium">Created</div>
                      <div className="text-label">{new Date(selected.created_at).toLocaleString()}</div>
                    </>
                  )}
                </div>
              </div>
              <div className="mb-5">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Actions</div>
                <div className="flex gap-1.5 flex-wrap">
                  <button className={cn(btnBase, btnSm)} onClick={() => handleToggle(selected)}>
                    {selected.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className={cn(btnBase, btnSm, btnDanger)} onClick={() => handleDelete(selected)}>
                    Delete
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-16 px-6 text-label-tertiary"><div className="text-[13px]">Select a schedule</div></div>
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
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] animate-[fade-in_200ms_ease]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[90vw] glass-modal glass-shine rounded-2xl p-7 z-[200] animate-[modal-slide-in_250ms_cubic-bezier(0.32,0.72,0,1)]">
          <form onSubmit={handleSubmit}>
            <Dialog.Title className="text-base font-semibold text-label mb-5 tracking-[-0.01em]">
              New Schedule
            </Dialog.Title>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Cron Expression *</label>
              <input className={inputBase} autoFocus value={form.cron} onChange={(e) => update("cron", e.target.value)} placeholder="*/30 * * * *" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Summary</label>
              <input className={inputBase} value={form.summary} onChange={(e) => update("summary", e.target.value)} placeholder="What should the scheduled agent do?" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Flow</label>
              <input className={inputBase} value={form.flow} onChange={(e) => update("flow", e.target.value)} placeholder="bare" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Repository</label>
              <input className={inputBase} value={form.repo} onChange={(e) => update("repo", e.target.value)} placeholder="/path/to/repo or ." />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Compute</label>
              <input className={inputBase} value={form.compute_name} onChange={(e) => update("compute_name", e.target.value)} placeholder="Optional compute target" />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Group</label>
              <input className={inputBase} value={form.group_name} onChange={(e) => update("group_name", e.target.value)} placeholder="Optional group name" />
            </div>
            <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-white/8">
              <button
                type="button"
                className={cn(btnBase, "px-3.5 py-[7px]")}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={cn(btnBase, "px-3.5 py-[7px]", btnPrimary)}
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
