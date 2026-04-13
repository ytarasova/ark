import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../../core/theme.js";
import { useEventLog } from "../hooks/useEventLog.js";
import { GLOBAL_HINTS } from "../helpers/statusBarHints.js";
import { SplitPane } from "../components/SplitPane.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { eventTypeColor } from "../helpers/colors.js";

interface EventsTabProps {
  pane: "left" | "right";
}

export function EventsTab({ pane }: EventsTabProps) {
  const theme = getTheme();
  const events = useEventLog(true);

  const { sel } = useListNavigation(events.length, { active: pane === "left" });
  const selected = events[sel] ?? null;

  // Aggregate counts by event type
  const typeCounts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const ev of events) {
      map.set(ev.type, (map.get(ev.type) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [events]);

  return (
    <SplitPane
      focus={pane}
      leftTitle={`Events (${events.length})`}
      rightTitle="Detail"
      left={
        events.length === 0 ? (
          <Text dimColor>No events yet.</Text>
        ) : (
          <Box flexDirection="column">
            {events.map((ev, i) => {
              const isSel = i === sel;
              return (
                <Text key={`${ev.time}-${ev.sessionId}-${i}`} inverse={isSel}>
                  {isSel ? "> " : "  "}
                  <Text dimColor>{ev.time.slice(0, 5)}  </Text>
                  <Text color={ev.color}>{ev.message.slice(0, 50).padEnd(52)}</Text>
                  <Text dimColor>{ev.source}</Text>
                </Text>
              );
            })}
          </Box>
        )
      }
      right={
        selected ? (
          <Box flexDirection="column">
            <Text bold color={selected.color}>{selected.type.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase())}</Text>
            <Text> </Text>
            <Text>Time:     <Text color={theme.accent}>{selected.time}</Text></Text>
            <Text>Session:  <Text color={theme.accent}>{selected.sessionId}</Text></Text>
            <Text>Source:   {selected.source}</Text>
            <Text>Type:     {selected.type}</Text>
            <Text> </Text>
            <Text bold>Message</Text>
            <Text>{selected.message}</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text bold>Events Overview</Text>
            <Text> </Text>
            <Text>Total: <Text color={theme.accent}>{events.length}</Text> events</Text>
            {events.length > 0 && (
              <Text>Latest: <Text dimColor>{events[0].time}</Text></Text>
            )}
            <Text> </Text>
            {typeCounts.length > 0 && (
              <>
                <Text bold>By Type</Text>
                {typeCounts.map(([type, count]) => (
                  <Text key={type}>
                    {"  "}<Text color={eventTypeColor(type)}>{type.padEnd(24)}</Text>
                    <Text dimColor>{count}</Text>
                  </Text>
                ))}
              </>
            )}
            <Text> </Text>
            <Text dimColor>Select an event to see details.</Text>
          </Box>
        )
      }
    />
  );
}

export function getEventsHints(): React.ReactNode[] {
  return [...GLOBAL_HINTS];
}
