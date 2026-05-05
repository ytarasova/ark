/**
 * Prerequisite checker - validates that required system tools are available.
 */

import { execFileSync } from "child_process";
import { tmuxBin } from "./infra/tmux.js";

export interface PrereqResult {
  name: string;
  version: string | null;
  ok: boolean;
  required: boolean;
  installHint?: string;
}

export function checkPrereqs(): PrereqResult[] {
  const results: PrereqResult[] = [];

  function check(name: string, args: string[], required: boolean, hint: string): void {
    try {
      const stdout = execFileSync(name, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
      results.push({ name, version: stdout.trim().split("\n")[0], ok: true, required });
    } catch {
      results.push({ name, version: null, ok: false, required, installHint: hint });
    }
  }

  check("bun", ["--version"], true, "curl -fsSL https://bun.sh/install | bash");
  // Prefer the bundled tmux next to the ark binary; fall back to PATH if not present.
  check(tmuxBin(), ["-V"], true, "The tarball should include tmux. Reinstall via install.sh, or: brew install tmux");
  check("git", ["--version"], true, "brew install git");
  check("claude", ["--version"], false, "npm install -g @anthropic-ai/claude-code");
  check("gh", ["--version"], false, "brew install gh (optional - needed for PR creation)");

  return results;
}

export function formatPrereqCheck(results: PrereqResult[]): string {
  const lines = results.map((r) => {
    const status = r.ok ? "OK" : r.required ? "MISSING" : "not found";
    const icon = r.ok ? "+" : r.required ? "x" : "-";
    const ver = r.version ? `  ${r.version}` : "";
    const hint = !r.ok && r.installHint ? `  Install: ${r.installHint}` : "";
    return `  ${icon} ${r.name.padEnd(10)}${ver}${r.ok ? "" : `  ${status}${hint}`}`;
  });
  return lines.join("\n");
}

export function hasRequiredPrereqs(results: PrereqResult[]): boolean {
  return results.filter((r) => r.required).every((r) => r.ok);
}
