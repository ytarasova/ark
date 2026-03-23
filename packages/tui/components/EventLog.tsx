import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import * as core from "../../core/index.js";

interface EventLogProps {
  expanded: boolean;
  onToggle: () => void;
}

interface DisplayEvent {
  time: string;
  source: string;  // session ID or host name
  type: string;
  stage?: string;
  detail: string;
  color: string;
}

export function EventLog({ expanded }: EventLogProps) {
  const [events, setEvents] = useState<DisplayEvent[]>([]);

  useEffect(() => {
    const refresh = () => {
      try {
        const allEvents: DisplayEvent[] = [];

        // Session events
        const sessions = core.listSessions({ limit: 15 });
        for (const s of sessions) {
          try {
            const evts = core.getEvents(s.id, { limit: expanded ? 10 : 3 });
            for (const ev of evts) {
              const summary = s.jira_summary ?? s.id;
              const detail = ev.data
                ? Object.entries(ev.data).slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(" ")
                : "";
              const color = ev.type.includes("error") || ev.type.includes("exit") || ev.type.includes("fail") ? "red"
                : ev.type.includes("complete") ? "green"
                : ev.type.includes("start") ? "cyan"
                : "gray";
              allEvents.push({
                time: hms(ev.created_at),
                source: summary.slice(0, 20),
                type: ev.type,
                stage: ev.stage ?? undefined,
                detail,
                color,
              });
            }
          } catch {}
        }

        // Sort newest first
        allEvents.sort((a, b) => b.time.localeCompare(a.time));
        setEvents(allEvents.slice(0, expanded ? 30 : 5));
      } catch {}
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [expanded]);

  const latest = events[0];

  if (!expanded) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          {"Events "}
          {latest
            ? <Text>
                <Text color={latest.color as any}>{latest.type}</Text>
                <Text dimColor>{` ${latest.source} ${latest.time} `}</Text>
                <Text dimColor bold>{"(e:expand)"}</Text>
              </Text>
            : <Text dimColor bold>{"(e:expand)"}</Text>
          }
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} height={Math.min(events.length + 2, 15)}>
      <Text bold>{"Events"}<Text dimColor>{" (e:collapse)"}</Text></Text>
      {events.map((ev, i) => (
        <Text key={i}>
          <Text dimColor>{`  ${ev.time}  `}</Text>
          <Text color={ev.color as any}>{ev.type.padEnd(20)}</Text>
          <Text color="cyan">{(ev.stage ?? "").padEnd(8)}</Text>
          <Text dimColor>{` ${ev.source.padEnd(20)} `}</Text>
          <Text dimColor>{ev.detail}</Text>
        </Text>
      ))}
    </Box>
  );
}

function hms(iso: string): string {
  try { return new Date(iso).toISOString().slice(11, 19); } catch { return ""; }
}
