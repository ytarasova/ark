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
import { buildTerminalTheme } from "../themes/terminal-theme.js";
import { useTheme } from "../themes/ThemeProvider.js";

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
  const termRef = useRef<XTerm | null>(null);
  const { themeName, colorMode } = useTheme();

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
      // overviewRuler.width drives the scrollbar gutter width too (default 14px
      // produces the chunky default-OS-looking thumb). Keep it 6px to match
      // the app's global ::-webkit-scrollbar rule.
      overviewRuler: { width: 6 },
      // Static replay: hide the cursor by painting it the same color as the
      // canvas. The canvas itself comes from the active theme.
      theme: (() => {
        const base = buildTerminalTheme();
        return { ...base, cursor: base.background };
      })(),
      scrollback: 100000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    term.open(containerRef.current);
    term.write(output);
    termRef.current = term;

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
      termRef.current = null;
    };
  }, [output, colsProp, rowsProp]);

  // Live theme reactivity: when the active theme/colorMode changes the CSS
  // variables on :root have already updated by the time this effect runs
  // (ThemeProvider applies them synchronously in its own effect), so reading
  // buildTerminalTheme() picks up the new tokens. Pushing to term.options.theme
  // triggers an internal repaint -- no remount needed.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const base = buildTerminalTheme();
    term.options.theme = { ...base, cursor: base.background };
  }, [themeName, colorMode]);

  return (
    <div className="panel-card" data-testid="static-terminal-panel">
      <div ref={containerRef} className="terminal-host" />
    </div>
  );
}
