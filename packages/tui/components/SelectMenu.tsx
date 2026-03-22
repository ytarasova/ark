import React from "react";
import SelectInput from "ink-select-input";

interface SelectMenuItem {
  label: string;
  value: string;
}

interface SelectMenuProps {
  items: SelectMenuItem[];
  onSelect: (item: SelectMenuItem) => void;
  limit?: number;
}

export function SelectMenu({ items, onSelect, limit }: SelectMenuProps) {
  return (
    <SelectInput
      items={items}
      onSelect={onSelect}
      limit={limit}
    />
  );
}
