import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import * as core from "../../core/index.js";

interface EventLogProps {
  expanded: boolean;
  onToggle: () => void;
}

export function EventLog({ expanded, onToggle }: EventLogProps) {
  const [events, setEvents] = useState<core.Event[]>([]);

  useEffect(() => {
    const refresh = () => {
      try {
        // Get recent events across all sessions
        const sessions = core.listSessions({ limit: 10 });
        const allEvents: core.Event[] = [];
        for (const s of sessions) {
          try {
            const evts = core.getEvents(s.id, { limit: 5 });
            allEvents.push(...evts);
          } catch {}
        }
        // Sort by timestamp, take latest
        allEvents.sort((a, b) => b.created_at.localeCompare(a.created_at));
        setEvents(allEvents.slice(0, expanded ? 20 : 3));
      } catch {}
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [expanded]);

  const hms = (iso: string) => {
    try { return new Date(iso).toISOString().slice(11, 19); } catch { return ""; }
  };

  if (!expanded) {
    // Collapsed: single line with latest event
    const latest = events[0];
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          {"Events "}
          {latest ? `${hms(latest.created_at)} ${latest.type} (e:expand)` : "(e:expand)"}
        </Text>
      </Box>
    );
  }

  // Expanded
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} height={Math.min(events.length + 2, 12)}>
      <Text bold>{"Events"}<Text dimColor>{" (e:collapse)"}</Text></Text>
      {events.map((ev, i) => (
        <Text key={i} dimColor>
          {`  ${hms(ev.created_at)}  ${ev.type.padEnd(20)} ${ev.stage ?? ""}`}
          {ev.data ? <Text color="gray">{`  ${Object.entries(ev.data).slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 25)}`).join(" ")}`}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}
