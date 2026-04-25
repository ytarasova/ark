import { useState, useEffect } from "react";
import { useTransport } from "../transport/TransportContext.js";

const BACKOFF_INITIAL = 500;
const BACKOFF_MAX = 5000;

export function useSse<T>(path: string): T | null {
  const [data, setData] = useState<T | null>(null);
  const transport = useTransport();

  useEffect(() => {
    let source: EventSource;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    let delay = BACKOFF_INITIAL;

    function connect() {
      const src = transport.createEventSource(path);
      source = src;

      src.addEventListener("sessions", (e) => {
        delay = BACKOFF_INITIAL;
        try {
          setData(JSON.parse((e as MessageEvent).data));
        } catch {
          // SSE payload is not valid JSON -- expected when the server sends
          // a heartbeat or an unrelated event type. Silent by design; the next
          // valid frame will update state.
        }
      });

      src.onerror = () => {
        // When readyState is CLOSED the browser will not retry; reconnect manually.
        if (src.readyState === EventSource.CLOSED) {
          if (!alive) return;
          if (timer !== null) clearTimeout(timer);
          const d = delay;
          delay = Math.min(d * 2, BACKOFF_MAX);
          timer = setTimeout(() => {
            if (!alive) return;
            connect();
          }, d);
        }
      };
    }

    connect();

    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      source.close();
    };
  }, [path, transport]);

  return data;
}
