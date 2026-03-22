import React from "react";
import { Text } from "ink";

interface SectionHeaderProps {
  title: string;
}

export function SectionHeader({ title }: SectionHeaderProps) {
  return <Text bold inverse>{` ${title} `}</Text>;
}
