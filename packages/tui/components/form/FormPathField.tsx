/**
 * Path input field with Tab completion.
 *
 * Navigation mode: shows path as plain text. Enter → edit mode.
 * Edit mode: TextInputEnhanced + Tab completion from getPathCompletions.
 */

import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { TextInputEnhanced } from "../TextInputEnhanced.js";
import { getPathCompletions } from "../PathInput.js";
import { FormField } from "./FormField.js";

interface FormPathFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  active: boolean;
  onEditChange?: (editing: boolean) => void;
}

export function FormPathField({ label, value, onChange, active, onEditChange }: FormPathFieldProps) {
  const [editing, setEditingState] = useState(false);

  const setEditing = (v: boolean) => {
    setEditingState(v);
    onEditChange?.(v);
  };

  const completions = useMemo(
    () => editing ? getPathCompletions(value) : [],
    [editing, value],
  );

  useInput((input, key) => {
    if (!active) return;
    if (editing) {
      if (key.tab && completions.length > 0) {
        onChange(completions[0] + "/");
      }
      return;
    }
    if (key.return) {
      setEditing(true);
    }
  });

  if (!active && editing) setEditing(false);

  return (
    <FormField label={label} active={active} editing={editing}>
      {editing ? (
        <Box flexDirection="column">
          <Box>
            <TextInputEnhanced
              value={value}
              onChange={onChange}
              onSubmit={() => setEditing(false)}
              focus={true}
              placeholder="/path/to/repo"
            />
          </Box>
          {completions.length > 0 && (
            <Box flexDirection="column" marginLeft={0}>
              {completions.slice(0, 5).map((c, i) => (
                <Text key={i} dimColor>{`  ${c}/`}</Text>
              ))}
            </Box>
          )}
        </Box>
      ) : (
        <Text>{value}</Text>
      )}
    </FormField>
  );
}
