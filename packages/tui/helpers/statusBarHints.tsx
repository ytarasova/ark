import React from "react";
import { Text } from "ink";
import type { Tab } from "../components/TabBar.js";

export function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color="white" bold>{k}</Text>
      <Text color="gray">:{label}  </Text>
    </Text>
  );
}

export const sep = (id: number) => <Text key={`sep-${id}`} dimColor>{" | "}</Text>;

/** Convert JSX hint elements to a plain text string for solid-background rendering */
export function flattenHints(hints: React.ReactNode[]): string {
  const parts: string[] = [];
  for (const h of hints) {
    if (React.isValidElement(h)) {
      const props = h.props as Record<string, unknown>;
      if (props.k && props.label) {
        parts.push(`${props.k}:${props.label}`);
      }
    }
  }
  return parts.join("  ");
}

/** Navigation hints shared by all left panes */
export const NAV_HINTS = [
  <KeyHint key="jk" k="j/k" label="move" />,
  <KeyHint key="fb" k="f/b" label="page" />,
  <KeyHint key="gG" k="g/G" label="top/end" />,
];

/** Global hints -- appear on second bar line */
export const GLOBAL_HINTS = [
  sep(99),
  <KeyHint key="?" k="?" label="help" />,
  <KeyHint key="q" k="q" label="quit" />,
];

/** Navigation bar text (always shown on line 2) */
export const NAV_BAR_TEXT = "j/k:move  f/b:page  g/G:top/end  Tab:pane  |  n:new  /:find  !/@/#/$:filter  |  ?:help  q:quit";

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
        <KeyHint key="/" k="/" label="search" />,
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
    hints.push(<KeyHint key="A" k="A" label="add todo" />);
    hints.push(<KeyHint key="T" k="T" label="toggle" />);
    hints.push(<KeyHint key="D" k="D" label="del todo" />);
  }
  hints.push(<KeyHint key="tab" k="Tab" label="back" />);
  hints.push(...GLOBAL_HINTS);
  return hints;
}

export function getGenericHints(): React.ReactNode[] {
  return [
    ...GLOBAL_HINTS,
  ];
}
