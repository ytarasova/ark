/**
 * Terminal hyperlink using OSC 8 escape sequence.
 * Renders clickable text in terminals that support it (iTerm2, Kitty, WezTerm).
 * Falls back to plain text in terminals that don't.
 */

import React from "react";
import { Text } from "ink";

interface LinkProps {
  url: string;
  children?: React.ReactNode;
  color?: string;
}

export function Link({ url, children, color = "blue" }: LinkProps) {
  const label = children ?? url;
  // OSC 8 hyperlink: \e]8;;URL\e\\label\e]8;;\e\\
  const linked = `\x1b]8;;${url}\x07${typeof label === "string" ? label : ""}\x1b]8;;\x07`;

  if (typeof label === "string") {
    return <Text color={color as any}>{linked}</Text>;
  }
  // For non-string children, wrap with escape codes
  return (
    <Text>
      {`\x1b]8;;${url}\x07`}
      <Text color={color as any}>{label}</Text>
      {`\x1b]8;;\x07`}
    </Text>
  );
}
