import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../hooks/useApi.js";
import { cn } from "../../lib/utils.js";
import { Modal } from "../ui/modal.js";
import { Button } from "../ui/button.js";

interface RestartDialogProps {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  onRestart: (rewindToStage: string | undefined) => Promise<void>;
}

/**
 * Stage picker for re-dispatching a session. Populated via `session/flowStages`.
 * "Continue here" (undefined rewind) re-runs the current stage; picking any
 * stage rewinds the pointer, drops cached claude_session_id + pr_url, and
 * re-dispatches from there.
 */
export function RestartDialog({ sessionId, open, onClose, onRestart }: RestartDialogProps) {
  const api = useApi();
  const flowQuery = useQuery({
    queryKey: ["session", sessionId, "flowStages"],
    queryFn: () => api.getFlowStages(sessionId),
    enabled: open,
    staleTime: 30_000,
  });
  const [selected, setSelected] = useState<string | "__continue__" | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setSelected(null);
  }, [open]);

  const stages = flowQuery.data?.stages ?? [];
  const currentStage = flowQuery.data?.currentStage ?? null;

  async function handleConfirm() {
    if (!selected) return;
    setSubmitting(true);
    try {
      await onRestart(selected === "__continue__" ? undefined : selected);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Restart session">
      <div className="flex flex-col gap-3 px-5 py-4 text-[12px]">
        <p className="text-[var(--fg-muted)]">
          Pick the stage to restart from. Rewinding clears the agent conversation id and PR link so the run starts fresh
          from that stage.
        </p>

        {flowQuery.isLoading && <div className="py-4 text-center text-[var(--fg-muted)]">Loading stages…</div>}
        {flowQuery.isError && (
          <div className="py-4 text-center text-[var(--failed)]">
            Failed to load stages: {(flowQuery.error as { message?: string })?.message ?? "unknown error"}
          </div>
        )}

        {!flowQuery.isLoading && !flowQuery.isError && (
          <div className="flex flex-col gap-1.5 max-h-[40vh] overflow-y-auto pr-1">
            <label
              className={cn(
                "flex items-start gap-2 px-3 py-2 rounded-md border cursor-pointer",
                selected === "__continue__"
                  ? "border-[var(--running)] bg-[var(--bg-hover)]"
                  : "border-[var(--border)] hover:bg-[var(--bg-hover)]",
              )}
            >
              <input
                type="radio"
                name="restart-stage"
                className="mt-1"
                checked={selected === "__continue__"}
                onChange={() => setSelected("__continue__")}
              />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">Continue at current stage{currentStage ? ` (${currentStage})` : ""}</span>
                <span className="text-[11px] text-[var(--fg-muted)]">
                  Re-run the current stage without resetting prior work.
                </span>
              </div>
            </label>

            {stages.map((s) => (
              <label
                key={s.name}
                className={cn(
                  "flex items-start gap-2 px-3 py-2 rounded-md border cursor-pointer",
                  selected === s.name
                    ? "border-[var(--running)] bg-[var(--bg-hover)]"
                    : "border-[var(--border)] hover:bg-[var(--bg-hover)]",
                )}
              >
                <input
                  type="radio"
                  name="restart-stage"
                  className="mt-1"
                  checked={selected === s.name}
                  onChange={() => setSelected(s.name)}
                />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    {s.name === currentStage && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--fg-muted)]">
                        current
                      </span>
                    )}
                    <span className="text-[10px] text-[var(--fg-muted)]">
                      {s.type === "action"
                        ? `action: ${s.action ?? ""}`
                        : s.type === "agent"
                          ? `agent: ${s.agent ?? ""}`
                          : s.type}
                    </span>
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleConfirm} disabled={!selected || submitting}>
          {submitting ? "Restarting…" : "Restart"}
        </Button>
      </div>
    </Modal>
  );
}
