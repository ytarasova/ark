import React from "react";
import { Text } from "ink";
import type { Tab } from "../components/TabBar.js";
import type { Session } from "../../core/index.js";

export function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color="white" bold>{k}</Text>
      <Text color="gray">:{label}  </Text>
    </Text>
  );
}

const sep = (id: number) => <Text key={`sep-${id}`} dimColor>{" | "}</Text>;

/** Navigation hints shared by all left panes */
const NAV_HINTS = [
  <KeyHint key="jk" k="j/k" label="move" />,
  <KeyHint key="fb" k="f/b" label="page" />,
  <KeyHint key="gG" k="g/G" label="top/end" />,
];

export function getOverlayHints(overlay: string): React.ReactNode[] {
  switch (overlay) {
    case "form":
      return [
        <KeyHint key="tab" k="Tab" label="navigate" />,
        <KeyHint key="enter" k="Enter" label="edit/select" />,
        <KeyHint key="esc" k="Esc" label="cancel" />,
      ];
    case "move":
    case "fork":
    case "group":
      return [
        <KeyHint key="enter" k="Enter" label="confirm" />,
        <KeyHint key="esc" k="Esc" label="cancel" />,
      ];
    case "mcp":
    case "skills":
      return [
        <KeyHint key="space" k="Space" label="toggle" />,
        <KeyHint key="enter" k="Enter" label="apply" />,
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
    case "find":
      return [
        <KeyHint key="jk" k="C-j/k" label="move" />,
        <KeyHint key="enter" k="Enter" label="select" />,
        <KeyHint key="esc" k="Esc" label="close" />,
      ];
    case "inbox":
      return [
        <KeyHint key="esc" k="Esc" label="close" />,
      ];
    case "settings":
      return [
        <KeyHint key="enter" k="Enter" label="toggle" />,
        <KeyHint key="esc" k="Esc" label="close" />,
      ];
    case "help":
      return [
        <KeyHint key="esc" k="?" label="close" />,
        <KeyHint key="esc2" k="Esc" label="close" />,
      ];
    case "replay":
      return [
        <KeyHint key="jk" k="j/k" label="step" />,
        <KeyHint key="enter" k="Enter" label="expand" />,
        <KeyHint key="/" k="/" label="search" />,
        <KeyHint key="esc" k="Esc" label="close" />,
      ];
    case "memory":
      return [
        <KeyHint key="jk" k="j/k" label="move" />,
        <KeyHint key="n" k="n" label="add" />,
        <KeyHint key="x" k="x" label="delete" />,
        <KeyHint key="esc" k="Esc" label="close" />,
      ];
    default:
      return [
        <KeyHint key="esc" k="Esc" label="cancel" />,
      ];
  }
}

export function getRightPaneHints(tab?: Tab): React.ReactNode[] {
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

export function getSessionHints(s: Session | null | undefined): React.ReactNode[] {
  const hints: React.ReactNode[] = [];

  // Navigation
  hints.push(...NAV_HINTS);
  hints.push(sep(0));

  // Sessions
  if (s) {
    // Interact with current session
    switch (s.status) {
      case "ready":
      case "blocked":
        hints.push(<KeyHint key="enter" k="Enter" label="dispatch" />);
        hints.push(<KeyHint key="A3" k="A" label="advance" />);
        break;
      case "running":
        hints.push(<KeyHint key="a" k="a" label="attach" />);
        hints.push(<KeyHint key="tT" k="t/T" label="chat/threads" />);
        hints.push(<KeyHint key="s" k="s" label="stop" />);
        hints.push(<KeyHint key="d" k="d" label="done" />);
        hints.push(<KeyHint key="A" k="A" label="advance" />);
        break;
      case "stopped":
      case "failed":
      case "completed":
        hints.push(<KeyHint key="enter" k="Enter" label="restart" />);
        hints.push(<KeyHint key="r" k="r" label="replay" />);
        hints.push(<KeyHint key="Z" k="Z" label="archive" />);
        break;
      case "archived":
        hints.push(<KeyHint key="Z" k="Z" label="restore" />);
        break;
      case "waiting":
        hints.push(<KeyHint key="a" k="a" label="attach" />);
        hints.push(<KeyHint key="tT2" k="t/T" label="chat/threads" />);
        hints.push(<KeyHint key="s" k="s" label="stop" />);
        hints.push(<KeyHint key="A2" k="A" label="advance" />);
        break;
    }
    // Create / duplicate
    hints.push(<KeyHint key="fC" k="f/C" label="fork/clone" />);
    hints.push(<KeyHint key="W" k="W" label="worktree" />);
    // Organize
    hints.push(<KeyHint key="u" k="u" label="unread" />);
    hints.push(<KeyHint key="m" k="m" label="move" />);
    hints.push(<KeyHint key="M" k="M" label="mcp" />);
    hints.push(<KeyHint key="K" k="K" label="skills" />);
    hints.push(<KeyHint key="Y" k="Y" label="memory" />);
    hints.push(<KeyHint key="x" k="x" label="delete" />);
  }
  hints.push(<KeyHint key="n" k="n" label="new" />);
  hints.push(<KeyHint key="o" k="o" label="groups" />);
  hints.push(<KeyHint key="/" k="/" label="find" />);
  hints.push(<KeyHint key="filter" k="!/@/#/$" label="filter" />);
  hints.push(<KeyHint key="P" k="P" label="settings" />);
  hints.push(<KeyHint key="?" k="?" label="help" />);
  hints.push(sep(1));

  // App
  hints.push(<KeyHint key="q" k="q" label="quit" />);
  return hints;
}

export function getComputeHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS, sep(0),
    <KeyHint key="enter" k="Enter" label="provision" />,
    <KeyHint key="s" k="s" label="start/stop" />,
    <KeyHint key="R" k="R" label="reboot" />,
    <KeyHint key="t" k="t" label="test" />,
    <KeyHint key="x" k="x" label="delete" />,
    <KeyHint key="c" k="c" label="clean" />,
    <KeyHint key="n" k="n" label="new" />, sep(1),
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

export function getHistoryHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS, sep(0),
    <KeyHint key="enter" k="Enter" label="import Claude" />,
    <KeyHint key="r" k="r/R" label="refresh/rebuild" />,
    <KeyHint key="s" k="s" label="search" />, sep(1),
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

export function getAgentsHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS, sep(0),
    <KeyHint key="n" k="n" label="new" />,
    <KeyHint key="e" k="e" label="edit" />,
    <KeyHint key="c" k="c" label="copy" />,
    <KeyHint key="x" k="x" label="delete" />, sep(1),
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

export function getToolsHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS, sep(0),
    <KeyHint key="enter" k="Enter" label="use recipe" />,
    <KeyHint key="x" k="x" label="delete" />, sep(1),
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

export function getFlowsHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS,
    <KeyHint key="tab" k="Tab" label="detail" />, sep(0),
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

export function getCostsHints(): React.ReactNode[] {
  return [
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

export function getSchedulesHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS, sep(0),
    <KeyHint key="n" k="n" label="new" />,
    <KeyHint key="e" k="e" label="enable/disable" />,
    <KeyHint key="x" k="x" label="delete" />,
    <KeyHint key="r" k="r" label="refresh" />, sep(1),
    <KeyHint key="q" k="q" label="quit" />,
  ];
}

export function getGenericHints(): React.ReactNode[] {
  return [
    <KeyHint key="q" k="q" label="quit" />,
  ];
}
