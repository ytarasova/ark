import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";

interface NewSessionModalProps {
  onClose: () => void;
  onSubmit: (form: { summary: string; repo: string; flow: string; group_name: string }) => void;
}

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
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] animate-[fade-in_200ms_ease]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[90vw] glass-modal glass-shine rounded-2xl p-7 z-[200] animate-[modal-slide-in_250ms_cubic-bezier(0.32,0.72,0,1)]">
          <form onSubmit={handleSubmit}>
            <Dialog.Title className="text-base font-semibold text-label mb-5 tracking-[-0.01em]">
              New Session
            </Dialog.Title>

            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Summary *</label>
              <input
                className="w-full glass-input rounded-lg px-3 py-2 text-[13px] text-label placeholder:text-label-quaternary outline-none focus:border-tint focus:shadow-[0_0_0_3px_var(--color-tint-dim)] transition-all duration-200"
                autoFocus
                value={form.summary}
                onChange={(e) => update("summary", e.target.value)}
                placeholder="What should the agent work on?"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Repository</label>
              <input
                className="w-full glass-input rounded-lg px-3 py-2 text-[13px] text-label placeholder:text-label-quaternary outline-none focus:border-tint focus:shadow-[0_0_0_3px_var(--color-tint-dim)] transition-all duration-200"
                value={form.repo}
                onChange={(e) => update("repo", e.target.value)}
                placeholder="/path/to/repo or ."
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Flow</label>
              <input
                className="w-full glass-input rounded-lg px-3 py-2 text-[13px] text-label placeholder:text-label-quaternary outline-none focus:border-tint focus:shadow-[0_0_0_3px_var(--color-tint-dim)] transition-all duration-200"
                value={form.flow}
                onChange={(e) => update("flow", e.target.value)}
                placeholder="default"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Group</label>
              <input
                className="w-full glass-input rounded-lg px-3 py-2 text-[13px] text-label placeholder:text-label-quaternary outline-none focus:border-tint focus:shadow-[0_0_0_3px_var(--color-tint-dim)] transition-all duration-200"
                value={form.group_name}
                onChange={(e) => update("group_name", e.target.value)}
                placeholder="Optional group name"
              />
            </div>

            <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-white/8">
              <button
                type="button"
                className="glass-btn inline-flex items-center justify-center gap-1.5 px-3.5 py-[7px] rounded-lg text-[13px] font-medium cursor-pointer text-label active:scale-[0.97] transition-all duration-200"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-[7px] rounded-lg text-[13px] font-semibold cursor-pointer bg-tint border-none text-white shadow-[0_2px_12px_rgba(124,106,239,0.3),inset_0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:scale-[0.97] transition-all duration-200"
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
