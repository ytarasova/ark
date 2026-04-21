import { useState, useCallback } from "react";
import { api } from "./useApi.js";

type Toast = (msg: string, type: string) => void;

/**
 * Encapsulates the async action handlers attached to a session detail view:
 * stop / restart / archive / delete + the review-gate approve/reject pair.
 *
 * Owns a single `actionLoading` string so exactly one button can show a
 * spinner at a time, and exposes handlers that already wire the toast + the
 * parent's `refetchDetail()` callback so `SessionDetail` stays a pure
 * composition.
 */
export function useSessionActions({
  sessionId,
  onToast,
  refetchDetail,
}: {
  sessionId: string;
  onToast: Toast;
  refetchDetail: () => void;
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleAction = useCallback(
    async (action: "stop" | "restart" | "archive" | "delete") => {
      setActionLoading(action);
      try {
        let res: any;
        switch (action) {
          case "stop":
            res = await api.stop(sessionId);
            break;
          case "restart":
            // Covers both "retry after failed dispatch" (status=ready/pending/blocked)
            // and "restart terminal session" (status=stopped/failed/completed).
            // `session/resume` is the single re-dispatch surface.
            res = await api.restart(sessionId);
            break;
          case "archive":
            res = await api.archive(sessionId);
            break;
          case "delete":
            // Confirmation happens via the in-app modal; by the time we're here,
            // the user has already confirmed.
            res = await api.deleteSession(sessionId);
            break;
          default:
            return;
        }
        if (res.ok !== false) {
          onToast(`Session ${sessionId} ${action} successful`, "success");
          refetchDetail();
        } else {
          const hint = action === "stop" ? ". The session may have already exited" : "";
          onToast(`Failed to ${action} session ${sessionId}: ${res.message || "unknown error"}${hint}`, "error");
        }
      } catch (err: any) {
        onToast(`Failed to ${action} session ${sessionId}: ${err.message || "network error"}`, "error");
      } finally {
        setActionLoading(null);
      }
    },
    [sessionId, onToast, refetchDetail],
  );

  const handleGateApprove = useCallback(async () => {
    setActionLoading("approve");
    try {
      const res = await api.gateApprove(sessionId);
      if (res.ok !== false) {
        onToast("Review gate approved", "success");
        refetchDetail();
      } else {
        onToast(`Approve failed: ${res.message ?? "unknown error"}`, "error");
      }
    } catch (err: any) {
      onToast(`Approve failed: ${err.message || "network error"}`, "error");
    } finally {
      setActionLoading(null);
    }
  }, [sessionId, onToast, refetchDetail]);

  const handleGateReject = useCallback(
    async (reason: string): Promise<boolean> => {
      const trimmed = reason.trim();
      if (!trimmed) {
        onToast("Reason is required", "error");
        return false;
      }
      setActionLoading("reject");
      try {
        const res = await api.sessionReject(sessionId, trimmed);
        if (res.ok !== false) {
          onToast("Rework dispatched", "success");
          refetchDetail();
          return true;
        }
        onToast(`Reject failed: ${res.message ?? "unknown error"}`, "error");
        return false;
      } catch (err: any) {
        onToast(`Reject failed: ${err.message || "network error"}`, "error");
        return false;
      } finally {
        setActionLoading(null);
      }
    },
    [sessionId, onToast, refetchDetail],
  );

  /**
   * Explicit restart entrypoint used by the Restart-from-stage dialog.
   * Accepts an optional `rewindToStage`; when undefined, re-runs the current
   * stage. Separate from `handleAction("restart")` because the dialog drives
   * the param, and the old "Restart" button no longer fires directly.
   */
  const handleRestart = useCallback(
    async (rewindToStage: string | undefined): Promise<void> => {
      setActionLoading("restart");
      try {
        const res = await api.restart(sessionId, rewindToStage ? { rewindToStage } : undefined);
        if (res.ok !== false) {
          onToast(
            rewindToStage
              ? `Session ${sessionId} restarted from ${rewindToStage}`
              : `Session ${sessionId} restart successful`,
            "success",
          );
          refetchDetail();
        } else {
          onToast(`Restart failed: ${res.message ?? "unknown error"}`, "error");
        }
      } catch (err: any) {
        onToast(`Restart failed: ${err.message || "network error"}`, "error");
      } finally {
        setActionLoading(null);
      }
    },
    [sessionId, onToast, refetchDetail],
  );

  return { actionLoading, handleAction, handleGateApprove, handleGateReject, handleRestart };
}
