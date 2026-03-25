import { useState, useCallback, useEffect, useRef } from "react";

/**
 * Manages a temporary status message that auto-clears after a timeout.
 */
export function useStatusMessage(clearMs = 5000) {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((msg: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(msg);
    timerRef.current = setTimeout(() => {
      setMessage(null);
      timerRef.current = null;
    }, clearMs);
  }, [clearMs]);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setMessage(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { message, show, clear };
}
