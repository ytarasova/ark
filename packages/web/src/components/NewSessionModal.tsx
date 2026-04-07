import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Separator } from "./ui/separator.js";

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
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[90vw] bg-card border border-border rounded-xl p-6 z-[200] shadow-2xl">
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
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Flow</label>
              <Input
                value={form.flow}
                onChange={(e) => update("flow", e.target.value)}
                placeholder="default"
              />
            </div>
            <div className="mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Group</label>
              <Input
                value={form.group_name}
                onChange={(e) => update("group_name", e.target.value)}
                placeholder="Optional group name"
              />
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
                Create Session
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
