import React from "react";
import { Box, Text } from "ink";

interface SectionHeaderProps {
  title: string;
}

export function SectionHeader({ title }: SectionHeaderProps) {
  return (
    <Box flexDirection="column">
      <Text bold inverse>{` ${title} `}</Text>
      <Text> </Text>
    </Box>
  );
}
