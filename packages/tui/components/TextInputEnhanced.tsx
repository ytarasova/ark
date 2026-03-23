/**
 * Enhanced text input with readline-style shortcuts:
 * - Ctrl+A: beginning of line
 * - Ctrl+E: end of line
 * - Ctrl+W: delete word backward
 * - Ctrl+U: delete to beginning
 * - Ctrl+K: delete to end
 * - Option+Left/Right (or Ctrl+Left/Right): word hop
 * - Ctrl+B/F: char left/right (standard readline)
 */

import React, { useState, useEffect } from "react";
import { Text, useInput } from "ink";

interface TextInputEnhancedProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}

export function TextInputEnhanced({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
}: TextInputEnhancedProps) {
  const [cursor, setCursor] = useState(value.length);

  // Keep cursor in bounds when value changes externally
  useEffect(() => {
    setCursor(c => Math.min(c, value.length));
  }, [value]);

  useInput((input, key) => {
    if (!focus) return;

    if (key.return) {
      onSubmit?.(value);
      return;
    }

    // Ctrl+A: beginning of line
    if (input === "a" && key.ctrl) {
      setCursor(0);
      return;
    }

    // Ctrl+E: end of line
    if (input === "e" && key.ctrl) {
      setCursor(value.length);
      return;
    }

    // Ctrl+B: char left
    if (input === "b" && key.ctrl) {
      setCursor(c => Math.max(0, c - 1));
      return;
    }

    // Ctrl+F: char right
    if (input === "f" && key.ctrl) {
      setCursor(c => Math.min(value.length, c + 1));
      return;
    }

    // Ctrl+W: delete word backward
    if (input === "w" && key.ctrl) {
      const before = value.slice(0, cursor);
      const after = value.slice(cursor);
      const wordStart = before.replace(/\S+\s*$/, "").length;
      onChange(before.slice(0, wordStart) + after);
      setCursor(wordStart);
      return;
    }

    // Ctrl+U: delete to beginning
    if (input === "u" && key.ctrl) {
      onChange(value.slice(cursor));
      setCursor(0);
      return;
    }

    // Ctrl+K: delete to end
    if (input === "k" && key.ctrl) {
      onChange(value.slice(0, cursor));
      return;
    }

    // Left arrow
    if (key.leftArrow) {
      if (key.meta) {
        // Option+Left: word hop backward
        const before = value.slice(0, cursor);
        const wordStart = before.replace(/\S+\s*$/, "").length;
        setCursor(wordStart);
      } else {
        setCursor(c => Math.max(0, c - 1));
      }
      return;
    }

    // Right arrow
    if (key.rightArrow) {
      if (key.meta) {
        // Option+Right: word hop forward
        const after = value.slice(cursor);
        const match = after.match(/^\s*\S+/);
        setCursor(c => c + (match ? match[0].length : after.length));
      } else {
        setCursor(c => Math.min(value.length, c + 1));
      }
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(c => c - 1);
      }
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta && input.length === 1) {
      onChange(value.slice(0, cursor) + input + value.slice(cursor));
      setCursor(c => c + 1);
    }
  });

  // Render with cursor
  const showPlaceholder = value.length === 0 && placeholder;
  const before = value.slice(0, cursor);
  const cursorChar = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);

  if (showPlaceholder) {
    return <Text dimColor>{placeholder}</Text>;
  }

  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}
