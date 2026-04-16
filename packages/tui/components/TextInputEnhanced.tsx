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
 *
 * Multi-line paste:
 * - Pasted text with newlines is preserved in the value
 * - Display is collapsed to MAX_DISPLAY_LINES; excess shown as "[+N lines]"
 * - Full text is submitted via onSubmit
 */

import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";

/** Max lines to render in the input box before collapsing. */
const MAX_DISPLAY_LINES = 3;

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
  const [cursor, _setCursor] = useState(value.length);
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);
  const internalEdit = useRef(false);

  // Update both state and ref atomically so rapid keystrokes read fresh values
  const setCursor = (c: number) => { cursorRef.current = c; _setCursor(c); };

  // Keep value ref in sync (parent controls value via props)
  valueRef.current = value;

  // Move cursor to end when value changes externally (e.g. Tab completion, submit clear)
  useEffect(() => {
    if (internalEdit.current) {
      internalEdit.current = false;
    } else {
      setCursor(value.length);
    }
  }, [value]);

  useInput((input, key) => {
    if (!focus) return;

    // Read from refs to avoid stale closures during fast typing
    const val = valueRef.current;
    const cur = cursorRef.current;

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
      onSubmit?.(val);
      return;
    }

    // Ctrl+A: beginning of line
    if (input === "a" && key.ctrl) {
      setCursor(0);
      return;
    }

    // Ctrl+E: end of line
    if (input === "e" && key.ctrl) {
      setCursor(val.length);
      return;
    }

    // Ctrl+B: char left
    if (input === "b" && key.ctrl) {
      setCursor(Math.max(0, cur - 1));
      return;
    }

    // Ctrl+F: char right
    if (input === "f" && key.ctrl) {
      setCursor(Math.min(val.length, cur + 1));
      return;
    }

    // Meta+B / Option+Left: word hop backward
    if (input === "b" && key.meta) {
      const before = val.slice(0, cur);
      const wordStart = before.replace(/\S+\s*$/, "").length;
      setCursor(wordStart);
      return;
    }

    // Meta+F / Option+Right: word hop forward
    if (input === "f" && key.meta) {
      const after = val.slice(cur);
      const match = after.match(/^\s*\S+/);
      setCursor(cur + (match ? match[0].length : after.length));
      return;
    }

    // Meta+D: delete word forward
    if (input === "d" && key.meta) {
      const after = val.slice(cur);
      const match = after.match(/^\s*\S+/);
      const wordEnd = cur + (match ? match[0].length : after.length);
      internalEdit.current = true;
      const next = val.slice(0, cur) + val.slice(wordEnd);
      onChange(next);
      valueRef.current = next;
      return;
    }

    // Ctrl+W: delete word backward
    if (input === "w" && key.ctrl) {
      const before = val.slice(0, cur);
      const after = val.slice(cur);
      const wordStart = before.replace(/\S+\s*$/, "").length;
      internalEdit.current = true;
      const next = before.slice(0, wordStart) + after;
      onChange(next);
      valueRef.current = next;
      setCursor(wordStart);
      cursorRef.current = wordStart;
      return;
    }

    // Ctrl+U: delete to beginning
    if (input === "u" && key.ctrl) {
      internalEdit.current = true;
      const next = val.slice(cur);
      onChange(next);
      valueRef.current = next;
      setCursor(0);
      cursorRef.current = 0;
      return;
    }

    // Ctrl+K: delete to end
    if (input === "k" && key.ctrl) {
      internalEdit.current = true;
      const next = val.slice(0, cur);
      onChange(next);
      valueRef.current = next;
      return;
    }

    // Left arrow
    if (key.leftArrow) {
      if (key.meta || key.ctrl) {
        // Option+Left / Ctrl+Left: word hop backward
        const before = val.slice(0, cur);
        const wordStart = before.replace(/\S+\s*$/, "").length;
        setCursor(wordStart);
      } else {
        setCursor(Math.max(0, cur - 1));
      }
      return;
    }

    // Right arrow
    if (key.rightArrow) {
      if (key.meta || key.ctrl) {
        // Option+Right / Ctrl+Right: word hop forward
        const after = val.slice(cur);
        const match = after.match(/^\s*\S+/);
        setCursor(cur + (match ? match[0].length : after.length));
      } else {
        setCursor(Math.min(val.length, cur + 1));
      }
      return;
    }

    // Option+Backspace: delete word backward (Mac default)
    if ((key.backspace || key.delete) && key.meta) {
      if (cur > 0) {
        const before = val.slice(0, cur);
        const after = val.slice(cur);
        const wordStart = before.replace(/\S+\s*$/, "").length;
        internalEdit.current = true;
        const next = before.slice(0, wordStart) + after;
        onChange(next);
        valueRef.current = next;
        setCursor(wordStart);
        cursorRef.current = wordStart;
      }
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (cur > 0) {
        internalEdit.current = true;
        const next = val.slice(0, cur - 1) + val.slice(cur);
        onChange(next);
        valueRef.current = next;
        setCursor(cur - 1);
        cursorRef.current = cur - 1;
      }
      return;
    }

    // Regular character input -- supports single chars and pasted text (multi-char)
    if (input && !key.ctrl && !key.meta) {
      // Strip control characters but preserve newlines (\n=0x0a, \r=0x0d)
      const clean = input.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, "").replace(/\r\n?/g, "\n");
      if (clean.length > 0) {
        internalEdit.current = true;
        const next = val.slice(0, cur) + clean + val.slice(cur);
        onChange(next);
        valueRef.current = next;
        const newCur = cur + clean.length;
        setCursor(newCur);
        cursorRef.current = newCur;
      }
    }
  });

  // Render with cursor
  const showPlaceholder = value.length === 0 && placeholder;

  if (showPlaceholder) {
    return <Text wrap="wrap"><Text inverse>{" "}</Text><Text dimColor>{placeholder}</Text></Text>;
  }

  // Multi-line collapse: if value has more lines than MAX_DISPLAY_LINES,
  // show a compact summary instead of the full text
  const lines = value.split("\n");
  if (lines.length > MAX_DISPLAY_LINES) {
    const theme = getTheme();
    const firstLine = lines[0].length > 60 ? lines[0].slice(0, 57) + "..." : lines[0];
    const extra = lines.length - 1;
    return (
      <Box>
        <Text>{firstLine} </Text>
        <Text dimColor color={theme.accent}>{`[+${extra} lines]`}</Text>
        <Text inverse>{" "}</Text>
      </Box>
    );
  }

  const before = value.slice(0, cursor);
  const cursorChar = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);

  return (
    <Text wrap="wrap">
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}
