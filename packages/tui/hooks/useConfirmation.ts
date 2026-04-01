/**
 * Reusable confirmation hook.
 *
 * Two-press pattern: first press shows warning, second press executes.
 * Auto-clears after timeout. Esc cancels.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { useStatusMessage } from "./useStatusMessage.js";

interface UseConfirmationOpts {
  /** Auto-clear after this many ms (default: 3000) */
  timeout?: number;
}

export function useConfirmation(opts?: UseConfirmationOpts) {
  const [pending, setPending] = useState<string | null>(null);
  const status = useStatusMessage();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeout = opts?.timeout ?? 3000;

  const clear = useCallback(() => {
    setPending(null);
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  /** Request confirmation. Returns true if already confirmed (second press). */
  const confirm = useCallback((action: string, message: string): boolean => {
    if (pending === action) {
      clear();
      return true; // Confirmed - execute
    }
    setPending(action);
    status.show(message);
    timerRef.current = setTimeout(clear, timeout);
    return false; // First press - waiting for confirmation
  }, [pending, clear, status, timeout]);

  // Clear on unmount
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { confirm, cancel: clear, pending, status };
}
