/**
 * Tests for consistent status color theme across components.
 *
 * Verifies that:
 * - CSS variables --running and --completed have correct hex values
 * - StageProgressBar maps done -> --completed and active -> --running
 * - StatusDot (both files) maps running -> --running and completed -> --completed
 * - FilterChip maps running -> --running and completed -> --completed
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const WEB_SRC = join(import.meta.dir, "..");

function readFile(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), "utf-8");
}

describe("CSS variables in styles.css", () => {
  const css = readFile("styles.css");

  test("--running is blue (#60a5fa)", () => {
    expect(css).toContain("--running: #60a5fa");
  });

  test("--completed is green (#34d399)", () => {
    expect(css).toContain("--completed: #34d399");
  });

  test("--failed is red (#f87171)", () => {
    expect(css).toContain("--failed: #f87171");
  });

  test("--waiting is amber (#fbbf24)", () => {
    expect(css).toContain("--waiting: #fbbf24");
  });
});

describe("StageProgressBar color mapping", () => {
  const src = readFile("components/ui/StageProgressBar.tsx");

  test("done state maps to --completed (green)", () => {
    expect(src).toContain('"bg-[var(--completed)]": s.state === "done"');
  });

  test("active state maps to --running (blue)", () => {
    expect(src).toContain('"bg-[var(--running)]": s.state === "active"');
  });

  test("failed state maps to --failed (red)", () => {
    expect(src).toContain('"bg-[var(--failed)]": s.state === "failed"');
  });

  test("pending state maps to --border (dim gray)", () => {
    expect(src).toContain('"bg-[var(--border)]": s.state === "pending"');
  });
});

describe("StatusDot (components/StatusDot.tsx) color mapping", () => {
  const src = readFile("components/StatusDot.tsx");

  test("running uses --running variable", () => {
    expect(src).toContain("bg-[var(--running)]");
    // running entry should reference --running
    const runningLine = src.split("\n").find((l) => l.includes("running:") && l.includes("bg-[var(--running)]"));
    expect(runningLine).toBeDefined();
  });

  test("completed uses --completed variable", () => {
    expect(src).toContain("bg-[var(--completed)]");
    const completedLine = src.split("\n").find((l) => l.includes("completed:") && l.includes("bg-[var(--completed)]"));
    expect(completedLine).toBeDefined();
  });
});

describe("StatusDot (components/ui/StatusDot.tsx) color mapping", () => {
  const src = readFile("components/ui/StatusDot.tsx");

  test("running uses --running variable", () => {
    const runningLine = src.split("\n").find((l) => l.includes("running:") && l.includes("bg-[var(--running)]"));
    expect(runningLine).toBeDefined();
  });

  test("completed uses --completed variable", () => {
    const completedLine = src.split("\n").find((l) => l.includes("completed:") && l.includes("bg-[var(--completed)]"));
    expect(completedLine).toBeDefined();
  });

  test("failed uses --failed variable", () => {
    const failedLine = src.split("\n").find((l) => l.includes("failed:") && l.includes("bg-[var(--failed)]"));
    expect(failedLine).toBeDefined();
  });
});

describe("FilterChip color mapping", () => {
  const src = readFile("components/ui/FilterChip.tsx");

  test("running chip uses --running variable", () => {
    const runningLine = src.split("\n").find((l) => l.includes("running:") && l.includes("var(--running)"));
    expect(runningLine).toBeDefined();
  });

  test("completed chip uses --completed variable", () => {
    const completedLine = src.split("\n").find((l) => l.includes("completed:") && l.includes("var(--completed)"));
    expect(completedLine).toBeDefined();
  });

  test("failed chip uses --failed variable", () => {
    const failedLine = src.split("\n").find((l) => l.includes("failed:") && l.includes("var(--failed)"));
    expect(failedLine).toBeDefined();
  });

  test("waiting chip uses --waiting variable", () => {
    const waitingLine = src.split("\n").find((l) => l.includes("waiting:") && l.includes("var(--waiting)"));
    expect(waitingLine).toBeDefined();
  });
});
