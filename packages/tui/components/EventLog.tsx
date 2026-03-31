import React from "react";
import { Box, Text } from "ink";
import { useEventLog } from "../hooks/useEventLog.js";

interface EventLogProps {
  expanded: boolean;
  onToggle: () => void;
}

export function EventLog({ expanded }: EventLogProps) {
  const events = useEventLog(expanded);
  const latest = events[0];

  if (!expanded) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>
          {"Events "}
          {latest
            ? <Text>
                <Text color={latest.color as any}>{latest.message}</Text>
                <Text dimColor>{` ${latest.time.slice(0, 5)} `}</Text>
                <Text dimColor bold>{"(e:expand)"}</Text>
              </Text>
            : <Text dimColor bold>{"(e:expand)"}</Text>
          }
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} height={Math.min(events.length + 2, 10)}>
      <Text bold>{"Events"}<Text dimColor>{" (e:collapse)"}</Text></Text>
      {events.map((ev, i) => (
        <Text key={i}>
          <Text dimColor>{`  ${ev.time.slice(0, 5)}  `}</Text>
          <Text color={ev.color as any}>{ev.message}</Text>
          <Text dimColor>{`  ${ev.source}`}</Text>
        </Text>
      ))}
    </Box>
  );
}
