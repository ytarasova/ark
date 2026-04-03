import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { TextInputEnhanced } from "./TextInputEnhanced.js";
import { readdirSync, statSync } from "fs";
import { join, dirname, basename } from "path";

interface PathInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

/**
 * Compute directory completions for the given partial path.
 * Returns up to 8 matching directories (hidden dirs excluded).
 */
export function getPathCompletions(value: string): string[] {
  try {
    const dir = value.endsWith("/") ? value : dirname(value);
    const prefix = value.endsWith("/") ? "" : basename(value);
    const entries = readdirSync(dir)
      .filter(
        (e) =>
          !e.startsWith(".") &&
          e.toLowerCase().startsWith(prefix.toLowerCase()),
      )
      .filter((e) => {
        try {
          return statSync(join(dir, e)).isDirectory();
        } catch {
          return false;
        }
      })
      .slice(0, 8)
      .map((e) => join(dir, e));
    return entries;
  } catch {
    return [];
  }
}

export function PathInput({ value, onChange, onSubmit }: PathInputProps) {
  const completions = useMemo(() => getPathCompletions(value), [value]);

  const handleTab = () => {
    if (completions.length === 1) {
      // Single match: complete with trailing slash for further navigation
      onChange(completions[0] + "/");
    } else if (completions.length > 1) {
      // Multiple matches: complete to longest common prefix
      let common = completions[0];
      for (let i = 1; i < completions.length; i++) {
        let j = 0;
        while (j < common.length && j < completions[i].length && common[j] === completions[i][j]) j++;
        common = common.slice(0, j);
      }
      if (common.length > value.length) {
        onChange(common);
      }
    }
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInputEnhanced
          value={value}
          onChange={onChange}
          onSubmit={() => onSubmit(value)}
          onTab={handleTab}
          placeholder="/path/to/repo"
        />
      </Box>
      {completions.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {completions.map((c, i) => (
            <Text key={i} dimColor>
              {c}/
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
