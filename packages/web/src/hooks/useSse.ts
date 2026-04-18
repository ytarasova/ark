import { useState, useEffect } from "react";
import { useTransport } from "../transport/TransportContext.js";

export function useSse<T>(path: string): T | null {
  const [data, setData] = useState<T | null>(null);
  const transport = useTransport();

  useEffect(() => {
    const source = transport.createEventSource(path);
    source.addEventListener("sessions", (e) => {
      try {
        setData(JSON.parse(e.data));
      } catch {
        /* ignore parse errors */
      }
    });
    source.onerror = () => {
      /* reconnects automatically */
    };
    return () => source.close();
  }, [path, transport]);

  return data;
}
