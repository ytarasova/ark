import { useState, useEffect } from "react";

export function useSse<T>(path: string): T | null {
  const [data, setData] = useState<T | null>(null);
  const TOKEN = new URLSearchParams(window.location.search).get("token");

  useEffect(() => {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${window.location.origin}${path}${TOKEN ? `${sep}token=${TOKEN}` : ""}`;
    const source = new EventSource(url);
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
  }, [path]);

  return data;
}
