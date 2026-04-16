import { useState, useCallback, useRef } from "react";

export interface AsyncState {
  loading: boolean;
  error: string | null;
  label: string | null;
  run: (label: string, action: (updateLabel: (msg: string) => void) => Promise<void> | void) => void;
  clearError: () => void;
}

interface QueuedAction {
  label: string;
  action: (updateLabel: (msg: string) => void) => Promise<void> | void;
}

/**
 * Async action runner with loading/error state and action queue.
 * Actions are queued -- rapid-fire calls don't drop silently.
 * @param onComplete -- called after every successful action (e.g. store.refresh)
 */
export function useAsync(onComplete?: () => void): AsyncState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const queue = useRef<QueuedAction[]>([]);
  const running = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const processQueue = useCallback(async () => {
    if (running.current) return;
    const next = queue.current.shift();
    if (!next) {
      setLoading(false);
      setLabel(null);
      return;
    }

    running.current = true;
    setLoading(true);
    setLabel(next.label);
    setError(null);

    // Yield so React can render the spinner before heavy work starts
    await new Promise(r => setTimeout(r, 0));

    const updateLabel = (msg: string) => setLabel(msg);
    try {
      await Promise.resolve(next.action(updateLabel));
      onCompleteRef.current?.();
    } catch (e: any) {
      setError(`${next.label} failed: ${e?.message ?? String(e)}`);
    }

    running.current = false;

    // Process next in queue
    if (queue.current.length > 0) {
      processQueue();
    } else {
      setLoading(false);
      setLabel(null);
    }
  }, []);

  const run = useCallback((actionLabel: string, action: ((updateLabel: (msg: string) => void) => Promise<void> | void) | (() => Promise<void> | void)) => {
    queue.current.push({ label: actionLabel, action });
    // Set loading state immediately so spinner renders in the same cycle
    if (!running.current) {
      setLoading(true);
      setLabel(actionLabel);
      processQueue();
    }
  }, [processQueue]);

  const clearError = useCallback(() => setError(null), []);

  return { loading, error, label, run, clearError };
}
