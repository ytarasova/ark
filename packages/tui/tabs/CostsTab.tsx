import React, { useMemo, useState, useEffect } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../../core/theme.js";
import { useArkClient } from "../hooks/useArkClient.js";
import { GLOBAL_HINTS } from "../helpers/statusBarHints.js";
import { SplitPane } from "../components/SplitPane.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { formatCost } from "../../core/observability/costs.js";

interface CostsTabProps {
  pane: "left" | "right";
}

export function CostsTab({ pane }: CostsTabProps) {
  const theme = getTheme();
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
            <Text>Cost:    <Text color={theme.waiting}>{formatCost(selected.cost)}</Text></Text>
            <Text>Model:   {selected.model ?? "unknown"}</Text>
            {selected.usage && (
              <>
                <Text>Tokens:  {((selected.usage.input_tokens + selected.usage.output_tokens) / 1000).toFixed(1)}K</Text>
                <Text>  Input:  {(selected.usage.input_tokens / 1000).toFixed(1)}K</Text>
                <Text>  Output: {(selected.usage.output_tokens / 1000).toFixed(1)}K</Text>
                {(selected.usage.cache_read_tokens ?? 0) > 0 && (
                  <Text>  Cache:  {((selected.usage.cache_read_tokens ?? 0) / 1000).toFixed(1)}K</Text>
                )}
              </>
            )}
            <Text> </Text>
            {/* Model breakdown with ASCII bar chart */}
            <Text bold>Cost by Model</Text>
            {byModel.map(([model, data]) => {
              const maxCost = byModel[0]?.[1]?.cost ?? 1;
              const barLen = Math.max(1, Math.round((data.cost / maxCost) * 20));
              const bar = "\u2588".repeat(barLen);
              return (
                <Text key={model}>
                  {"  "}{model.padEnd(12)}<Text color={theme.accent}>{bar}</Text>
                  {"  "}<Text color={theme.waiting}>{formatCost(data.cost).padEnd(10)}</Text>
                  <Text dimColor>{data.count} sessions</Text>
                </Text>
              );
            })}

            {/* Sparkline: cost per session trend (last 20) */}
            {costs.length > 1 && (() => {
              const recent = costs.slice(0, 20).reverse();
              const maxC = Math.max(...recent.map(c => c.cost), 0.01);
              const SPARK = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
              const sparkline = recent.map(c => {
                const idx = Math.min(7, Math.floor((c.cost / maxC) * 7));
                return SPARK[idx];
              }).join("");
              return (
                <>
                  <Text> </Text>
                  <Text bold>Cost Trend (recent sessions)</Text>
                  <Text>  <Text color={theme.accent}>{sparkline}</Text></Text>
                  <Text dimColor>  {"oldest".padEnd(sparkline.length - 6)}newest</Text>
                </>
              );
            })()}
          </Box>
        ) : (
          <Box flexDirection="column">
            {/* Default: overview with model bars and sparkline */}
            <Text bold>Cost Overview</Text>
            <Text> </Text>
            <Text>Total: <Text color={theme.waiting}>{formatCost(total)}</Text>  ({costs.length} sessions)</Text>
            <Text> </Text>

            {/* ASCII bar chart by model */}
            {byModel.length > 0 && (
              <>
                <Text bold>By Model</Text>
                {byModel.map(([model, data]) => {
                  const maxCost = byModel[0]?.[1]?.cost ?? 1;
                  const barLen = Math.max(1, Math.round((data.cost / maxCost) * 20));
                  const bar = "\u2588".repeat(barLen);
                  return (
                    <Text key={model}>
                      {"  "}{model.padEnd(12)}<Text color={theme.accent}>{bar}</Text>
                      {"  "}<Text color={theme.waiting}>{formatCost(data.cost).padEnd(10)}</Text>
                      <Text dimColor>{data.count} sessions</Text>
                    </Text>
                  );
                })}
              </>
            )}

            {/* Sparkline */}
            {costs.length > 1 && (() => {
              const recent = costs.slice(0, 30).reverse();
              const maxC = Math.max(...recent.map(c => c.cost), 0.01);
              const SPARK = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
              const sparkline = recent.map(c => {
                const idx = Math.min(7, Math.floor((c.cost / maxC) * 7));
                return SPARK[idx];
              }).join("");
              return (
                <>
                  <Text> </Text>
                  <Text bold>Cost Trend</Text>
                  <Text>  <Text color={theme.accent}>{sparkline}</Text></Text>
                  <Text dimColor>  {"oldest".padEnd(Math.max(0, sparkline.length - 6))}newest</Text>
                </>
              );
            })()}

            <Text> </Text>
            <Text dimColor>Select a session to see details.</Text>
          </Box>
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
