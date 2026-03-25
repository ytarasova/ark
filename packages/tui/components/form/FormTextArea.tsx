/**
 * Multi-line text area field.
 *
 * Navigation mode: shows first line preview. Enter → edit mode.
 * Edit mode: captures keystrokes, Ctrl+Enter or Esc to finish.
 * Newlines entered with Enter (since Ctrl+Enter finishes).
 *
 * Note: In terminal, true multi-line editing is limited.
 * This renders all lines and accepts input at the end.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { FormField } from "./FormField.js";

interface FormTextAreaProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  active: boolean;
  placeholder?: string;
  /** Max lines to show when not editing */
  previewLines?: number;
}

export function FormTextArea({
  label, value, onChange, active, placeholder, previewLines = 2,
}: FormTextAreaProps) {
  const [editing, setEditing] = useState(false);

  useInput((input, key) => {
    if (!active || !editing) {
      if (active && key.return) setEditing(true);
      return;
    }

    // Esc exits edit mode
    if (key.escape) { setEditing(false); return; }

    // Ctrl+D finishes editing
    if (input === "d" && key.ctrl) { setEditing(false); return; }

    // Enter adds newline
    if (key.return) {
      onChange(value + "\n");
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (value.length > 0) onChange(value.slice(0, -1));
      return;
    }

    // Regular character or pasted text
    if (input && !key.ctrl && !key.meta) {
      // For textarea, keep newlines from pasted text but strip other control chars
      const clean = input.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, "");
      if (clean.length > 0) onChange(value + clean);
    }
  });

  if (!active && editing) setEditing(false);

  const lines = value.split("\n");

  return (
    <FormField label={label} active={active} editing={editing}>
      {editing ? (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i}>
              {line}
              {i === lines.length - 1 && <Text inverse>{" "}</Text>}
            </Text>
          ))}
        </Box>
      ) : (
        <Text>
          {value
            ? lines.slice(0, previewLines).join(" ").slice(0, 60) + (lines.length > previewLines ? "..." : "")
            : (placeholder ? <Text dimColor>{placeholder}</Text> : "")}
        </Text>
      )}
    </FormField>
  );
}
