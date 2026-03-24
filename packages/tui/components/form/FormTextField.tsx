/**
 * Single-line text input field.
 *
 * Navigation mode: shows value as plain text. Enter → edit mode.
 * Edit mode: TextInputEnhanced captures keystrokes. Enter → done.
 * j/k navigate away in navigation mode.
 */

import React, { useState } from "react";
import { Text, useInput } from "ink";
import { TextInputEnhanced } from "../TextInputEnhanced.js";
import { FormField } from "./FormField.js";

interface FormTextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  active: boolean;
  placeholder?: string;
  /** Notify form when entering/exiting edit mode */
  onEditChange?: (editing: boolean) => void;
}

export function FormTextField({ label, value, onChange, active, placeholder, onEditChange }: FormTextFieldProps) {
  const [editing, setEditingState] = useState(false);

  const setEditing = (v: boolean) => {
    setEditingState(v);
    onEditChange?.(v);
  };

  useInput((input, key) => {
    if (!active) return;
    if (editing) return;
    if (key.return) setEditing(true);
  });

  if (!active && editing) setEditing(false);

  return (
    <FormField label={label} active={active} editing={editing}>
      {editing ? (
        <TextInputEnhanced
          value={value}
          onChange={onChange}
          onSubmit={() => setEditing(false)}
          focus={true}
          placeholder={placeholder}
        />
      ) : (
        <Text>{value || (placeholder ? <Text dimColor>{placeholder}</Text> : "")}</Text>
      )}
    </FormField>
  );
}
