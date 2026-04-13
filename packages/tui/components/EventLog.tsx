import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../../core/theme.js";
import { useEventLog } from "../hooks/useEventLog.js";

interface EventLogProps {
  expanded: boolean;
}

export function EventLog({ expanded }: EventLogProps) {
  const theme = getTheme();
  const events = useEventLog(expanded);
  const latest = events[0];

  if (!expanded) {
    return (
      <Box borderStyle="single" borderColor={theme.dimText} paddingX={1}>
        <Text dimColor>
          {"Events "}
          {latest
            ? <Text>
                <Text color={latest.color}>{latest.message}</Text>
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
    <Box flexDirection="column" borderStyle="single" borderColor={theme.dimText} paddingX={1} height={Math.min(events.length + 2, 10)}>
      <Text bold>{"Events"}<Text dimColor>{" (e:collapse)"}</Text></Text>
      {events.map((ev, idx) => (
        <Text key={`${ev.time}-${ev.source}-${idx}`}>
          <Text dimColor>{`  ${ev.time.slice(0, 5)}  `}</Text>
          <Text color={ev.color}>{ev.message}</Text>
          <Text dimColor>{`  ${ev.source}`}</Text>
        </Text>
      ))}
    </Box>
  );
}
