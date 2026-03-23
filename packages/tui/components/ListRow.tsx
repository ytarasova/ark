import React from "react";
import { Text } from "ink";

interface ListRowProps {
  selected: boolean;
  children: string;
}

/**
 * A list row that highlights the full panel width when selected.
 * Pass plain text as children — colors are not supported in selected state
 * (inverse flattens them). Use colored Text in unselected state by
 * rendering ListRow only for selected and custom Text for unselected.
 */
export function ListRow({ selected, children }: ListRowProps) {
  if (selected) {
    return <Text bold inverse>{children.padEnd(200)}</Text>;
  }
  return <Text>{children}</Text>;
}
