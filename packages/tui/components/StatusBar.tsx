import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { Tab } from "./TabBar.js";
import type { Session } from "../../core/index.js";

interface StatusBarProps {
  tab: Tab;
  sessions: Session[];
  selectedSession?: Session | null;
  loading: boolean;
  error: string | null;
  label: string | null;
}

function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color="cyan" bold>{k}</Text>
      <Text dimColor>:{label}  </Text>
    </Text>
  );
}

function getSessionHints(s: Session | null | undefined): React.ReactNode[] {
  const hints: React.ReactNode[] = [
    <KeyHint key="jk" k="j/k" label="move" />,
  ];

  if (!s) {
    hints.push(<KeyHint key="n" k="n" label="new" />);
    hints.push(<KeyHint key="q" k="q" label="quit" />);
    return hints;
  }

  switch (s.status) {
    case "ready":
    case "blocked":
      hints.push(<KeyHint key="enter" k="Enter" label="dispatch" />);
      hints.push(<KeyHint key="x" k="x" label="delete" />);
      break;
    case "running":
      hints.push(<KeyHint key="a" k="a" label="attach" />);
      hints.push(<KeyHint key="s" k="s" label="stop" />);
      hints.push(<KeyHint key="c" k="c" label="done" />);
      break;
    case "failed":
      hints.push(<KeyHint key="enter" k="Enter" label="retry" />);
      hints.push(<KeyHint key="x" k="x" label="delete" />);
      break;
    case "completed":
      hints.push(<KeyHint key="x" k="x" label="delete" />);
      break;
    case "waiting":
      hints.push(<KeyHint key="r" k="r" label="resume" />);
      hints.push(<KeyHint key="s" k="s" label="stop" />);
      break;
  }

  hints.push(<KeyHint key="n" k="n" label="new" />);
  hints.push(<KeyHint key="e" k="e" label="events" />);
  hints.push(<KeyHint key="q" k="q" label="quit" />);
  return hints;
}

function getHostHints(): React.ReactNode[] {
  return [
    <KeyHint key="jk" k="j/k" label="move" />,
    <KeyHint key="enter" k="Enter" label="provision" />,
    <KeyHint key="s" k="s" label="start/stop" />,
    <KeyHint key="a" k="a" label="ssh" />,
    <KeyHint key="c" k="c" label="clean" />,
    <KeyHint key="n" k="n" label="new" />,
    <KeyHint key="x" k="x" label="delete" />,
    <KeyHint key="e" k="e" label="events" />,
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

function getGenericHints(): React.ReactNode[] {
  return [
    <KeyHint key="jk" k="j/k" label="move" />,
    <KeyHint key="e" k="e" label="events" />,
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

export function StatusBar({ tab, sessions, selectedSession, loading, error, label }: StatusBarProps) {
  const nRun = sessions.filter((s) => s.status === "running").length;
  const nErr = sessions.filter((s) => s.status === "failed").length;

  const hints = tab === "sessions" ? getSessionHints(selectedSession)
    : tab === "hosts" ? getHostHints()
    : getGenericHints();

  return (
    <Box flexDirection="column">
      {error && (
        <Box>
          <Text color="red">{` ${error}`}</Text>
        </Box>
      )}
      <Box backgroundColor="gray">
        {loading && label ? (
          <>
            <Text color="yellow">
              {" "}<Spinner type="dots" />{` ${label}`}
            </Text>
            <Text>{"  "}</Text>
          </>
        ) : (
          <Text color="white">{` ${sessions.length} sessions`}</Text>
        )}
        {!loading && nRun > 0 && <Text color="cyan">{`  ●${nRun} running`}</Text>}
        {nErr > 0 && <Text color="red">{`  ✕${nErr} failed`}</Text>}
        <Text>{"  "}</Text>
        {hints}
      </Box>
    </Box>
  );
}
