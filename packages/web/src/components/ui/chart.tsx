/**
 * Chart utilities -- theme-aware colors, custom tooltip, and shared defaults.
 *
 * Recharts kept: animations disabled, colors from CSS vars, custom tooltip.
 * Switching libraries would add dep churn with no functional gain.
 */

import { useState, useEffect } from "react";

/** Reads CSS custom properties from the document root and returns a chart-ready palette. */
export function useChartColors() {
  const [colors, setColors] = useState(() => readColors());

  useEffect(() => {
    // Re-read on theme change (class mutation on <html> or <body>)
    const observer = new MutationObserver(() => {
      setColors(readColors());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, []);

  return colors;
}

function readColors() {
  const s = getComputedStyle(document.documentElement);
  const get = (name: string) => s.getPropertyValue(name).trim();

  return {
    primary: get("--primary") || "#7c6aef",
    running: get("--running") || "#34d399",
    completed: get("--completed") || "#60a5fa",
    waiting: get("--waiting") || "#fbbf24",
    failed: get("--failed") || "#f87171",
    stopped: get("--stopped") || "rgba(107,114,128,0.4)",

    fg: get("--foreground") || get("--fg") || "#e8e8ec",
    fgMuted: get("--muted-foreground") || get("--fg-muted") || "#8888a0",
    card: get("--card") || get("--bg-card") || "#1a1a20",
    border: get("--border") || "#2a2a35",
    background: get("--background") || get("--bg") || "#101014",
  };
}

/** Ordered chart series palette derived from theme tokens. */
export function useChartPalette(): string[] {
  const c = useChartColors();
  return [c.primary, c.running, c.completed, c.waiting, c.failed];
}

/** Model-to-color mapping using theme tokens. */
export function useModelColors(): Record<string, string> {
  const c = useChartColors();
  return {
    opus: c.failed,
    sonnet: c.primary,
    haiku: c.running,
    unknown: c.completed,
  };
}

/**
 * Custom chart tooltip matching Ark's card style.
 * Pass as `content={<ChartTooltip />}` to Recharts Tooltip.
 */
export function ChartTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null;

  return (
    <div
      style={{
        background: "var(--card, #1a1a20)",
        border: "1px solid var(--border, #2a2a35)",
        borderRadius: 6,
        padding: "8px 12px",
        fontSize: 12,
        fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
        color: "var(--foreground, #e8e8ec)",
        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
        lineHeight: 1.5,
      }}
    >
      {label && (
        <div
          style={{
            fontSize: 10,
            color: "var(--muted-foreground, #8888a0)",
            marginBottom: 4,
            fontWeight: 500,
          }}
        >
          {label}
        </div>
      )}
      {payload.map((entry: any, i: number) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: entry.color || entry.fill || entry.payload?.fill || "var(--primary)",
              flexShrink: 0,
            }}
          />
          <span style={{ color: "var(--muted-foreground, #8888a0)" }}>{entry.name}</span>
          <span style={{ marginLeft: "auto", fontWeight: 600, color: "var(--foreground, #e8e8ec)" }}>
            {formatter ? formatter(entry.value, entry.name) : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Subtle grid stroke that works in both light and dark modes. */
export const GRID_STROKE = "var(--border, #2a2a35)";
export const GRID_STROKE_OPACITY = 0.4;

/** Axis tick style matching Ark's typography. */
export const AXIS_TICK_STYLE = {
  fontSize: 10,
  fill: "var(--muted-foreground, #8888a0)",
  fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
};
