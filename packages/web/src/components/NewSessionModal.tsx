import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../lib/utils.js";

interface NewSessionModalProps {
  onClose: () => void;
  onSubmit: (form: { summary: string; repo: string; flow: string; group_name: string }) => void;
}

const inputClass = "w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 text-[13px] text-white/90 placeholder:text-white/25 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 outline-none transition-all";
const btnClass = "px-3.5 py-1.5 text-[13px] font-medium rounded-md border border-white/[0.06] text-white/50 hover:text-white/80 hover:border-white/[0.1] transition-colors";
const btnPrimary = "px-3.5 py-1.5 text-[13px] font-semibold rounded-md bg-indigo-500 border border-indigo-500/50 text-white hover:bg-indigo-400 transition-colors";

export function NewSessionModal({ onClose, onSubmit }: NewSessionModalProps) {
  const [form, setForm] = useState({ summary: "", repo: ".", flow: "", group_name: "" });

  function update(key: string, val: string) {
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
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[90vw] bg-[#111116] border border-white/[0.08] rounded-xl p-6 z-[200] shadow-2xl">
          <form onSubmit={handleSubmit}>
            <Dialog.Title className="text-base font-semibold text-white/90 mb-5">
              New Session
            </Dialog.Title>

            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Summary *</label>
              <input
                className={inputClass}
                autoFocus
                value={form.summary}
                onChange={(e) => update("summary", e.target.value)}
                placeholder="What should the agent work on?"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Repository</label>
              <input
                className={inputClass}
                value={form.repo}
                onChange={(e) => update("repo", e.target.value)}
                placeholder="/path/to/repo or ."
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Flow</label>
              <input
                className={inputClass}
                value={form.flow}
                onChange={(e) => update("flow", e.target.value)}
                placeholder="default"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Group</label>
              <input
                className={inputClass}
                value={form.group_name}
                onChange={(e) => update("group_name", e.target.value)}
                placeholder="Optional group name"
              />
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
                Create Session
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
