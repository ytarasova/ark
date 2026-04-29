/**
 * Static terminal renderer -- displays recorded terminal output using xterm.js
 * so ANSI escape codes (colors, formatting) render correctly.
 *
 * Column detection strategy:
 *   1. Use the explicit `cols` prop when provided. `session.pty_cols` /
 *      `pty_rows` are observed on the first resize from the live terminal
 *      panel, so the replay renders at the same width the live agent saw.
 *   2. Otherwise fall back to auto-detection -- widest line after ANSI strip,
 *      floored at 120. This covers sessions that never got a live client
 *      (CLI-only dispatches) and pre-observation rows still NULL in the DB.
 *
 * The container has overflow-x-auto so users can scroll to see long lines
 * even when the measured geometry exceeds the browser viewport.
 */

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface StaticTerminalProps {
  output: string;
  /** Explicit column count (session.pty_cols). Falls back to auto-detect. */
  cols?: number | null;
  /** Explicit row count (session.pty_rows). Only used as an initial hint;
   *  fitRows() still adjusts to the container. */
  rows?: number | null;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DEFAULT_COL_FLOOR = 120;
// xterm.js rejects `undefined` rows in the constructor ("rows must be numeric").
// Any positive number works as a seed -- `fitRows()` resizes to the real
// container height immediately after `open()`. 24 is the classic vt100 default.
const INITIAL_ROWS_FALLBACK = 24;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function detectCols(output: string): number {
  let max = DEFAULT_COL_FLOOR;
  for (const line of stripAnsi(output).split("\n")) {
    if (line.length > max) max = line.length;
  }
  return max;
}

export function StaticTerminal({ output, cols: colsProp, rows: rowsProp }: StaticTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !output) return;

    const cols = colsProp && colsProp > 0 ? colsProp : detectCols(output);

    const term = new XTerm({
      cols,
      rows: rowsProp && rowsProp > 0 ? rowsProp : INITIAL_ROWS_FALLBACK,
      cursorBlink: false,
      disableStdin: true,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
      theme: {
        background: "#0a0a0a",
        foreground: "#e4e4e7",
        cursor: "#0a0a0a",
        selectionBackground: "#3f3f46",
        black: "#09090b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#fafafa",
      },
      scrollback: 100000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    term.open(containerRef.current);
    term.write(output);

    // FitAddon measures the container post-paint and sizes xterm to match.
    // The manual `clientHeight / cellHeight` calc we used previously ran at
    // 0×0 during the first render (before flex resolved) and never grew the
    // canvas after the layout settled, so the replay collapsed to one row.
    const fitNow = () => {
      try {
        fit.fit();
      } catch {
        /* container not yet attached */
      }
    };
    fitNow();
    const resizeObserver = new ResizeObserver(fitNow);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [output, colsProp, rowsProp]);

  return (
    <div className="panel-card" data-testid="static-terminal-panel">
      <div className="panel-card-header">
        <span>terminal · replay</span>
      </div>
      <div ref={containerRef} className="terminal-host" />
    </div>
  );
}
