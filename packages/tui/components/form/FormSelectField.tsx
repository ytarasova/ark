/**
 * Select field — inline dropdown menu.
 *
 * When active: SelectMenu renders, j/k navigate options, Enter picks.
 * When inactive: shows current value as plain text.
 * The form's navigation keys (Tab/Shift+Tab) still work since
 * SelectMenu doesn't capture Tab.
 */

import React from "react";
import { Text } from "ink";
import { SelectMenu } from "../SelectMenu.js";
import { FormField } from "./FormField.js";

interface SelectItem {
  label: string;
  value: string;
}

interface FormSelectFieldProps {
  label: string;
  value: string;
  items: SelectItem[];
  onSelect: (value: string) => void;
  active: boolean;
  /** Display text when inactive. Defaults to value. */
  displayValue?: string;
}

export function FormSelectField({
  label, value, items, onSelect, active, displayValue,
}: FormSelectFieldProps) {
  return (
    <FormField label={label} active={active}>
      {active ? (
        <SelectMenu
          items={items}
          onSelect={(item) => onSelect(item.value)}
        />
      ) : (
        <Text>{displayValue ?? (value || "(none)")}</Text>
      )}
    </FormField>
  );
}
