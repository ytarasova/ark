/**
 * Fetches and transforms session events into a flat, sorted display list.
 * Polls on an interval via useEffect; data transform is pure.
 */

import { useState, useEffect } from "react";
import { useArkClient } from "./useArkClient.js";
import type { ArkClient } from "../../protocol/client.js";
import { formatEvent } from "../helpers/formatEvent.js";
import { eventLogColor, type InkColor } from "../helpers/colors.js";

export interface EventLogEntry {
  time: string;
  source: string;
  type: string;
  message: string;
  color: InkColor;
}

function hms(iso: string): string {
  try { return new Date(iso).toISOString().slice(11, 19); } catch { return ""; }
}

async function fetchEvents(ark: ArkClient, expanded: boolean): Promise<EventLogEntry[]> {
  const allEvents: EventLogEntry[] = [];

  try {
    const sessions = await ark.sessionList({ limit: 15 });
    await Promise.all(sessions.map(async (s: any) => {
      try {
        const evts = await ark.sessionEvents(s.id, expanded ? 10 : 3);
        for (const ev of evts) {
          const source = (s.summary ?? s.id).slice(0, 20);
          allEvents.push({
            time: hms(ev.created_at),
            source,
            type: ev.type,
            message: formatEvent(ev.type, ev.data ?? undefined),
            color: eventLogColor(ev.type),
          });
        }
      } catch { /* skip sessions with missing events */ }
    }));
  } catch { /* event loading is best-effort */ }

  allEvents.sort((a, b) => b.time.localeCompare(a.time));
  return allEvents.slice(0, expanded ? 30 : 5);
}

export function useEventLog(expanded: boolean): EventLogEntry[] {
  const ark = useArkClient();
  const [events, setEvents] = useState<EventLogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const result = await fetchEvents(ark, expanded);
      if (!cancelled) setEvents(result);
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [ark, expanded]);

  return events;
}
