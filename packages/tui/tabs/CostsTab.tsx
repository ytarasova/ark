import React, { useMemo, useState, useEffect } from "react";
import { Box, Text } from "ink";
import { useArkClient } from "../hooks/useArkClient.js";
import { GLOBAL_HINTS } from "../helpers/statusBarHints.js";
import { SplitPane } from "../components/SplitPane.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { formatCost } from "../../core/costs.js";

interface CostsTabProps {
  pane: "left" | "right";
}

export function CostsTab({ pane }: CostsTabProps) {
  const ark = useArkClient();
  const [costs, setCosts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const load = () => {
      ark.costsRead().then((result) => {
        setCosts(result.costs ?? []);
        setTotal(result.total ?? 0);
      }).catch(() => {});
    };
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, []);

  const { sel } = useListNavigation(costs.length, { active: pane === "left" });
  const selected = costs[sel] ?? null;

  // Per-model aggregation
  const byModel = useMemo(() => {
    const map = new Map<string, { cost: number; tokens: number; count: number }>();
    for (const c of costs) {
      const model = c.model ?? "unknown";
      const entry = map.get(model) ?? { cost: 0, tokens: 0, count: 0 };
      entry.cost += c.cost;
      entry.tokens += c.usage?.total_tokens ?? 0;
      entry.count += 1;
      map.set(model, entry);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].cost - a[1].cost);
  }, [costs]);

  return (
    <SplitPane
      focus={pane}
      leftTitle={`Costs - ${formatCost(total)}`}
      rightTitle="Detail"
      left={
        costs.length === 0 ? (
          <Text dimColor>No cost data yet. Costs are tracked when sessions complete.</Text>
        ) : (
          <Box flexDirection="column">
            {costs.map((c, i) => {
              const isSel = i === sel;
              const summary = (c.summary ?? c.sessionId ?? "-").slice(0, 30).padEnd(32);
              const cost = formatCost(c.cost).padEnd(10);
              return (
                <Text key={c.sessionId ?? i} inverse={isSel}>
                  {isSel ? "> " : "  "}{summary}{cost}
                </Text>
              );
            })}
          </Box>
        )
      }
      right={
        selected ? (
          <Box flexDirection="column">
            <Text bold>{selected.summary ?? selected.sessionId}</Text>
            <Text> </Text>
            <Text>Cost:    <Text color="yellow">{formatCost(selected.cost)}</Text></Text>
            <Text>Model:   {selected.model ?? "unknown"}</Text>
            {selected.usage && (
              <>
                <Text>Tokens:  {(selected.usage.total_tokens / 1000).toFixed(1)}K</Text>
                <Text>  Input:  {(selected.usage.input_tokens / 1000).toFixed(1)}K</Text>
                <Text>  Output: {(selected.usage.output_tokens / 1000).toFixed(1)}K</Text>
                {selected.usage.cache_read_input_tokens > 0 && (
                  <Text>  Cache:  {(selected.usage.cache_read_input_tokens / 1000).toFixed(1)}K</Text>
                )}
              </>
            )}
            <Text> </Text>
            {/* Model breakdown summary */}
            <Text bold>By Model</Text>
            {byModel.map(([model, data]) => (
              <Text key={model}>
                {"  "}{model.padEnd(15)}<Text color="yellow">{formatCost(data.cost).padEnd(10)}</Text>
                <Text dimColor>{data.count} sessions</Text>
              </Text>
            ))}
          </Box>
        ) : (
          <Text dimColor>Select a session to see cost details.</Text>
        )
      }
    />
  );
}

export function getCostsHints(): React.ReactNode[] {
  return [
    ...GLOBAL_HINTS,
  ];
}
