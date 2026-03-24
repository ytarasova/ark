import { useState, useCallback, useRef, useEffect } from "react";

export interface AsyncState {
  loading: boolean;
  error: string | null;
  label: string | null;
  run: (label: string, action: () => Promise<void> | void) => void;
  clearError: () => void;
}

interface PendingAction {
  label: string;
  action: () => Promise<void> | void;
}

/**
 * Async action runner with loading/error state.
 * @param onComplete — called after every successful action (e.g. store.refresh)
 */
export function useAsync(onComplete?: () => void): AsyncState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const running = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!pending || running.current) return;
    running.current = true;

    setLoading(true);
    setLabel(pending.label);
    setError(null);

    const { label: actionLabel, action } = pending;
    setPending(null);

    Promise.resolve(action())
      .then(() => {
        onCompleteRef.current?.();
      })
      .catch((e: any) => {
        setError(`${actionLabel} failed: ${e?.message ?? String(e)}`);
      })
      .finally(() => {
        running.current = false;
        setLoading(false);
        setLabel(null);
      });
  }, [pending]);

  const run = useCallback((actionLabel: string, action: () => Promise<void> | void) => {
    if (running.current) return;
    setPending({ label: actionLabel, action });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { loading, error, label, run, clearError };
}
