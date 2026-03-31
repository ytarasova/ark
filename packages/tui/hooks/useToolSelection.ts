import { useState } from "react";
import { useInput } from "ink";

/**
 * Hook for managing a checkbox-list tool selection UI.
 * Handles j/k navigation and space/enter toggling.
 */
export function useToolSelection(
  toolOptions: string[],
  initialTools: string[],
  active: boolean,
): {
  tools: string[];
  setTools: React.Dispatch<React.SetStateAction<string[]>>;
  toolCursor: number;
} {
  const [tools, setTools] = useState<string[]>(initialTools);
  const [toolCursor, setToolCursor] = useState(0);

  useInput((input, key) => {
    if (!active) return;
    if (input === "j" || key.downArrow) setToolCursor(c => Math.min(c + 1, toolOptions.length - 1));
    if (input === "k" || key.upArrow) setToolCursor(c => Math.max(c - 1, 0));
    if (input === " " || key.return) {
      const tool = toolOptions[toolCursor];
      setTools(prev => prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]);
    }
  });

  return { tools, setTools, toolCursor };
}
