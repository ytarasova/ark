import { useState, useCallback } from "react";

export interface AsyncState {
  loading: boolean;
  error: string | null;
  label: string | null;
  run: (label: string, action: () => Promise<void>) => void;
  clearError: () => void;
}

export function useAsync(): AsyncState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);

  const run = useCallback((actionLabel: string, action: () => Promise<void>) => {
    setLoading(true);
    setLabel(actionLabel);
    setError(null);
    action()
      .catch((e: any) => {
        setError(`${actionLabel} failed: ${e?.message ?? String(e)}`);
      })
      .finally(() => {
        setLoading(false);
        setLabel(null);
      });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { loading, error, label, run, clearError };
}
