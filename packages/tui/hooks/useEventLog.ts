/**
 * Fetches and transforms session events into a flat, sorted display list.
 * Polls on an interval via useEffect; data transform is pure.
 */

import { useState, useEffect, useRef } from "react";
import { listSessions, getEvents } from "../../core/index.js";
import { formatEvent } from "../helpers/formatEvent.js";

export interface EventLogEntry {
  time: string;
  source: string;
  type: string;
  message: string;
  color: string;
}

function hms(iso: string): string {
  try { return new Date(iso).toISOString().slice(11, 19); } catch { return ""; }
}

function colorForType(type: string): string {
  if (type.includes("error") || type.includes("exit") || type.includes("fail")) return "red";
  if (type.includes("complete")) return "green";
  if (type.includes("start")) return "cyan";
  return "gray";
}

function fetchEvents(expanded: boolean): EventLogEntry[] {
  const allEvents: EventLogEntry[] = [];

  try {
    const sessions = listSessions({ limit: 15 });
    for (const s of sessions) {
      try {
        const evts = getEvents(s.id, { limit: expanded ? 10 : 3 });
        for (const ev of evts) {
          const source = (s.summary ?? s.id).slice(0, 20);
          allEvents.push({
            time: hms(ev.created_at),
            source,
            type: ev.type,
            message: formatEvent(ev.type, ev.data ?? undefined),
            color: colorForType(ev.type),
          });
        }
      } catch {}
    }
  } catch {}

  allEvents.sort((a, b) => b.time.localeCompare(a.time));
  return allEvents.slice(0, expanded ? 30 : 5);
}

export function useEventLog(expanded: boolean): EventLogEntry[] {
  const [events, setEvents] = useState<EventLogEntry[]>([]);

  useEffect(() => {
    const refresh = () => setEvents(fetchEvents(expanded));
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [expanded]);

  return events;
}
