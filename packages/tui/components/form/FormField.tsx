/**
 * Base form field wrapper — consistent label, focus indicator, spacing.
 * All specialized fields (Text, Select, Path, TextArea) use this.
 */

import React from "react";
import { Box, Text } from "ink";

interface FormFieldProps {
  label: string;
  active: boolean;
  /** Shows * when editing (text fields) */
  editing?: boolean;
  children: React.ReactNode;
}

export function FormField({ label, active, editing, children }: FormFieldProps) {
  return (
    <Box marginBottom={1}>
      <Text color={active ? "cyan" : "gray"}>
        {active ? (editing ? "* " : "> ") : "  "}
      </Text>
      <Text color={active ? "white" : "gray"} bold={active}>
        {`${label.padEnd(10)} `}
      </Text>
      {children}
    </Box>
  );
}
