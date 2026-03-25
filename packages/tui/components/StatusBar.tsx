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
  pane?: "left" | "right";
  overlay?: string | null;
  /** Number of items in the active tab's left pane list (for conditional scroll hints) */
  listLength?: number;
}

function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color="white" bold>{k}</Text>
      <Text color="gray">:{label}  </Text>
    </Text>
  );
}

function getOverlayHints(overlay: string): React.ReactNode[] {
  switch (overlay) {
    case "form":
      return [
        <KeyHint key="tab" k="Tab" label="navigate" />,
        <KeyHint key="enter" k="Enter" label="edit/select" />,
        <KeyHint key="esc" k="Esc" label="cancel" />,
      ];
    case "move":
    case "clone":
    case "group":
      return [
        <KeyHint key="enter" k="Enter" label="confirm" />,
        <KeyHint key="esc" k="Esc" label="cancel" />,
      ];
    case "talk":
      return [
        <KeyHint key="enter" k="Enter" label="send" />,
        <KeyHint key="esc" k="Esc" label="close" />,
      ];
    case "search":
      return [
        <KeyHint key="enter" k="Enter" label="search" />,
        <KeyHint key="esc" k="Esc" label="cancel" />,
      ];
    case "inbox":
      return [
        <KeyHint key="esc" k="Esc" label="close" />,
      ];
    default:
      return [
        <KeyHint key="esc" k="Esc" label="cancel" />,
      ];
  }
}

function getRightPaneHints(): React.ReactNode[] {
  return [
    <KeyHint key="jk" k="j/k" label="scroll" />,
    <KeyHint key="fb" k="f/b" label="page" />,
    <KeyHint key="gG" k="g/G" label="top/end" />,
    <KeyHint key="tab" k="Tab" label="back" />,
  ];
}

/** Navigation hints shared by all left panes. Page/top/end only when scrollable. */
function navHints(listLength: number): React.ReactNode[] {
  const hints = [<KeyHint key="jk" k="j/k" label="move" />];
  if (listLength > 20) {
    hints.push(<KeyHint key="fb" k="f/b" label="page" />);
    hints.push(<KeyHint key="gG" k="g/G" label="top/end" />);
  }
  return hints;
}

function getSessionHints(s: Session | null | undefined, listLength: number): React.ReactNode[] {
  const hints: React.ReactNode[] = [
    ...navHints(listLength),
    <KeyHint key="tab" k="Tab" label="detail" />,
  ];

  if (s) {
    switch (s.status) {
      case "ready":
      case "blocked":
        hints.push(<KeyHint key="enter" k="Enter" label="dispatch" />);
        hints.push(<KeyHint key="x" k="x" label="delete" />);
        break;
      case "running":
        hints.push(<KeyHint key="a" k="a" label="attach" />);
        hints.push(<KeyHint key="t" k="t" label="talk" />);
        hints.push(<KeyHint key="s" k="s" label="stop" />);
        hints.push(<KeyHint key="d" k="d" label="done" />);
        break;
      case "stopped":
      case "failed":
        hints.push(<KeyHint key="enter" k="Enter" label="restart" />);
        hints.push(<KeyHint key="x" k="x" label="delete" />);
        break;
      case "completed":
        hints.push(<KeyHint key="enter" k="Enter" label="restart" />);
        hints.push(<KeyHint key="x" k="x" label="delete" />);
        break;
      case "waiting":
        hints.push(<KeyHint key="a" k="a" label="attach" />);
        hints.push(<KeyHint key="s" k="s" label="stop" />);
        break;
    }
    hints.push(<KeyHint key="c" k="c" label="clone" />);
    hints.push(<KeyHint key="m" k="m" label="move" />);
  }

  hints.push(<KeyHint key="i" k="i" label="threads" />);
  hints.push(<KeyHint key="g" k="g" label="groups" />);
  hints.push(<KeyHint key="n" k="n" label="new" />);
  hints.push(<KeyHint key="q" k="q" label="quit" />);
  return hints;
}

function getComputeHints(listLength: number): React.ReactNode[] {
  return [
    ...navHints(listLength),
    <KeyHint key="enter" k="Enter" label="provision" />,
    <KeyHint key="s" k="s" label="start/stop" />,
    <KeyHint key="c" k="c" label="clean" />,
    <KeyHint key="n" k="n" label="new" />,
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

function getHistoryHints(listLength: number): React.ReactNode[] {
  return [
    ...navHints(listLength),
    <KeyHint key="enter" k="Enter" label="import" />,
    <KeyHint key="r" k="r" label="refresh" />,
    <KeyHint key="R" k="R" label="rebuild" />,
    <KeyHint key="s" k="s" label="search" />,
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

function getGenericHints(): React.ReactNode[] {
  return [
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

export function StatusBar({ tab, sessions, selectedSession, loading, error, label, pane, overlay, listLength = 0 }: StatusBarProps) {
  const nRun = sessions.filter((s) => s.status === "running").length;
  const nErr = sessions.filter((s) => s.status === "failed").length;

  const hints = overlay ? getOverlayHints(overlay)
    : pane === "right" ? getRightPaneHints()
    : tab === "sessions" ? getSessionHints(selectedSession, listLength)
    : tab === "compute" ? getComputeHints(listLength)
    : tab === "history" ? getHistoryHints(listLength)
    : getGenericHints();

  return (
    <Box flexDirection="column">
      {error && (
        <Box>
          <Text color="red">{` ${error}`}</Text>
        </Box>
      )}
      <Box>
        <Text bold>{` ${sessions.length} sessions`}</Text>
        {!loading && nRun > 0 && <Text color="green">{`  ● ${nRun} running`}</Text>}
        {nErr > 0 && <Text color="red">{`  ✕ ${nErr} failed`}</Text>}
        <Text>{"   "}</Text>
        {hints}
      </Box>
    </Box>
  );
}
