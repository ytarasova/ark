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

function getRightPaneHints(tab?: Tab): React.ReactNode[] {
  const hints: React.ReactNode[] = [
    <KeyHint key="jk" k="j/k" label="scroll" />,
    <KeyHint key="fb" k="f/b" label="page" />,
    <KeyHint key="gG" k="g/G" label="top/end" />,
  ];
  if (tab === "sessions") {
    hints.push(<KeyHint key="/" k="/" label="search" />);
  }
  hints.push(<KeyHint key="tab" k="Tab" label="back" />);
  return hints;
}

/** Navigation hints shared by all left panes */
const NAV_HINTS = [
  <KeyHint key="jk" k="j/k" label="move" />,
  <KeyHint key="fb" k="f/b" label="page" />,
  <KeyHint key="gG" k="g/G" label="top/end" />,
];

let sepId = 0;
const sep = () => <Text key={`sep-${sepId++}`} dimColor>{" | "}</Text>;

function getSessionHints(s: Session | null | undefined): React.ReactNode[] {
  sepId = 0;
  const hints: React.ReactNode[] = [];

  // Navigation
  hints.push(...NAV_HINTS);
  hints.push(sep());

  // Sessions
  if (s) {
    // Interact with current session
    switch (s.status) {
      case "ready":
      case "blocked":
        hints.push(<KeyHint key="enter" k="Enter" label="dispatch" />);
        break;
      case "running":
        hints.push(<KeyHint key="a" k="a" label="attach" />);
        hints.push(<KeyHint key="tT" k="t/T" label="chat/threads" />);
        hints.push(<KeyHint key="s" k="s" label="stop" />);
        hints.push(<KeyHint key="d" k="d" label="done" />);
        break;
      case "stopped":
      case "failed":
      case "completed":
        hints.push(<KeyHint key="enter" k="Enter" label="restart" />);
        break;
      case "waiting":
        hints.push(<KeyHint key="a" k="a" label="attach" />);
        hints.push(<KeyHint key="tT2" k="t/T" label="chat/threads" />);
        hints.push(<KeyHint key="s" k="s" label="stop" />);
        break;
    }
    // Create / duplicate
    hints.push(<KeyHint key="cC" k="c/C" label="fork/clone" />);
    // Organize
    hints.push(<KeyHint key="m" k="m" label="move" />);
    hints.push(<KeyHint key="x" k="x" label="delete" />);
  }
  hints.push(<KeyHint key="n" k="n" label="new" />);
  hints.push(<KeyHint key="o" k="o" label="groups" />);
  hints.push(sep());

  // App
  hints.push(<KeyHint key="q" k="q" label="quit" />);
  return hints;
}

function getComputeHints(): React.ReactNode[] {
  sepId = 0;
  return [
    ...NAV_HINTS, sep(),
    <KeyHint key="enter" k="Enter" label="provision" />,
    <KeyHint key="s" k="s" label="start/stop" />,
    <KeyHint key="R" k="R" label="reboot" />,
    <KeyHint key="t" k="t" label="test" />,
    <KeyHint key="x" k="x" label="delete" />,
    <KeyHint key="c" k="c" label="clean" />,
    <KeyHint key="n" k="n" label="new" />, sep(),
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

function getHistoryHints(): React.ReactNode[] {
  sepId = 0;
  return [
    ...NAV_HINTS, sep(),
    <KeyHint key="enter" k="Enter" label="import" />,
    <KeyHint key="r" k="r/R" label="refresh/rebuild" />,
    <KeyHint key="s" k="s" label="search" />, sep(),
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

function getAgentsHints(): React.ReactNode[] {
  sepId = 0;
  return [
    ...NAV_HINTS, sep(),
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

function getToolsHints(): React.ReactNode[] {
  sepId = 0;
  return [
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

function getFlowsHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS,
    <KeyHint key="tab" k="Tab" label="detail" />,
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

function getGenericHints(): React.ReactNode[] {
  return [
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

export function StatusBar({ tab, sessions, selectedSession, loading, error, label, pane, overlay }: StatusBarProps) {
  const nRun = sessions.filter((s) => s.status === "running").length;
  const nErr = sessions.filter((s) => s.status === "failed").length;

  const hints = overlay ? getOverlayHints(overlay)
    : pane === "right" ? getRightPaneHints(tab)
    : tab === "sessions" ? getSessionHints(selectedSession)
    : tab === "agents" ? getAgentsHints()
    : tab === "tools" ? getToolsHints()
    : tab === "flows" ? getFlowsHints()
    : tab === "compute" ? getComputeHints()
    : tab === "history" ? getHistoryHints()
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
