import React, { useMemo, useState, useEffect } from "react";
import { Box, Text } from "ink";
import { useArkClient } from "../hooks/useArkClient.js";
import { formatCost } from "../../core/costs.js";

export function CostsTab() {
  const ark = useArkClient();
  const [costs, setCosts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const fetch = () => {
      ark.costsRead().then((result) => {
        setCosts(result.costs);
        setTotal(result.total);
      }).catch(() => {});
    };
    fetch();
    const interval = setInterval(fetch, 10_000);
    return () => clearInterval(interval);
  }, []);

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

  if (costs.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text dimColor>No cost data yet. Costs are tracked when sessions complete.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="green">Total: {formatCost(total)}</Text>
        <Text dimColor>  ({costs.length} sessions with usage data)</Text>
      </Box>

      {/* Model breakdown */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>By Model</Text>
        {byModel.map(([model, data]) => (
          <Box key={model}>
            <Text>{model.padEnd(15)}</Text>
            <Text color="yellow">{formatCost(data.cost).padEnd(10)}</Text>
            <Text dimColor>{(data.tokens / 1000).toFixed(0)}K tokens</Text>
            <Text dimColor>  ({data.count} sessions)</Text>
          </Box>
        ))}
      </Box>

      {/* Top sessions */}
      <Box flexDirection="column">
        <Text bold underline>Top Sessions</Text>
        {costs.slice(0, 15).map((c) => (
          <Box key={c.sessionId}>
            <Text>{(c.summary ?? c.sessionId).slice(0, 35).padEnd(37)}</Text>
            <Text color="yellow">{formatCost(c.cost).padEnd(10)}</Text>
            <Text dimColor>{c.model ?? "?"}</Text>
          </Box>
        ))}
        {costs.length > 15 && (
          <Text dimColor>  ... and {costs.length - 15} more</Text>
        )}
      </Box>
    </Box>
  );
}
