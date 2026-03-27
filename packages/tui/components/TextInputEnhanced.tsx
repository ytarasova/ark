/**
 * Enhanced text input with readline-style shortcuts + Mac defaults:
 *
 * Navigation:
 * - Left/Right: move one character
 * - Option+Left/Right: word hop backward/forward
 * - Ctrl+A / Home: beginning of line
 * - Ctrl+E / End: end of line
 * - Ctrl+B/F: char left/right (standard readline)
 *
 * Deletion:
 * - Backspace: delete character backward
 * - Option+Backspace: delete word backward
 * - Ctrl+W: delete word backward (readline)
 * - Ctrl+U: delete to beginning of line
 * - Ctrl+K: delete to end of line
 */

import React, { useState, useEffect, useRef } from "react";
import { Text, useInput } from "ink";

interface TextInputEnhancedProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onTab?: () => void;
  onUpArrow?: () => void;
  onDownArrow?: () => void;
  placeholder?: string;
  focus?: boolean;
}

export function TextInputEnhanced({
  value,
  onChange,
  onSubmit,
  onTab,
  onUpArrow,
  onDownArrow,
  placeholder,
  focus = true,
}: TextInputEnhancedProps) {
  const [cursor, setCursor] = useState(value.length);
  const internalEdit = useRef(false);

  // Move cursor to end when value changes externally (e.g. Tab completion)
  useEffect(() => {
    if (internalEdit.current) {
      internalEdit.current = false;
    } else {
      setCursor(value.length);
    }
  }, [value]);

  useInput((input, key) => {
    if (!focus) return;

    if (key.tab && onTab) {
      onTab();
      return;
    }

    if (key.upArrow && onUpArrow) {
      onUpArrow();
      return;
    }

    if (key.downArrow && onDownArrow) {
      onDownArrow();
      return;
    }

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
      internalEdit.current = true;
      onChange(before.slice(0, wordStart) + after);
      setCursor(wordStart);
      return;
    }

    // Ctrl+U: delete to beginning
    if (input === "u" && key.ctrl) {
      internalEdit.current = true;
      onChange(value.slice(cursor));
      setCursor(0);
      return;
    }

    // Ctrl+K: delete to end
    if (input === "k" && key.ctrl) {
      internalEdit.current = true;
      onChange(value.slice(0, cursor));
      return;
    }

    // Left arrow
    if (key.leftArrow) {
      if (key.meta || key.ctrl) {
        // Option+Left / Ctrl+Left: word hop backward
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
      if (key.meta || key.ctrl) {
        // Option+Right / Ctrl+Right: word hop forward
        const after = value.slice(cursor);
        const match = after.match(/^\s*\S+/);
        setCursor(c => c + (match ? match[0].length : after.length));
      } else {
        setCursor(c => Math.min(value.length, c + 1));
      }
      return;
    }

    // Option+Backspace: delete word backward (Mac default)
    if ((key.backspace || key.delete) && key.meta) {
      if (cursor > 0) {
        const before = value.slice(0, cursor);
        const after = value.slice(cursor);
        const wordStart = before.replace(/\S+\s*$/, "").length;
        internalEdit.current = true;
        onChange(before.slice(0, wordStart) + after);
        setCursor(wordStart);
      }
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        internalEdit.current = true;
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(c => c - 1);
      }
      return;
    }

    // Regular character input — supports single chars and pasted text (multi-char)
    if (input && !key.ctrl && !key.meta) {
      // Strip control characters (keep printable chars, including unicode)
      const clean = input.replace(/[\x00-\x1f]/g, "");
      if (clean.length > 0) {
        internalEdit.current = true;
        onChange(value.slice(0, cursor) + clean + value.slice(cursor));
        setCursor(c => c + clean.length);
      }
    }
  });

  // Render with cursor
  const showPlaceholder = value.length === 0 && placeholder;
  const before = value.slice(0, cursor);
  const cursorChar = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);

  if (showPlaceholder) {
    return <Text><Text inverse>{" "}</Text><Text dimColor>{placeholder}</Text></Text>;
  }

  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}
