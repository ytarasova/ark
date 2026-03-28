// ── Helper utilities ─────────────────────────────────────────────────────────

export function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function hms(iso: string | null): string {
  if (!iso) return "";
  try { return new Date(iso).toISOString().slice(11, 19); } catch { return ""; }
}

export function bar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const color = pct > 80 ? "red" : pct > 50 ? "yellow" : "green";
  return `{${color}-fg}${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}{/${color}-fg}`;
}

export function generateName(): string {
  const adj = ["swift","bold","calm","dark","epic","fast","grim","hazy","keen","loud",
    "mild","neat","odd","pure","rare","slim","tall","vast","warm","wild",
    "blue","gold","iron","jade","ruby","sage","teal","onyx","zinc","moss"];
  const noun = ["wolf","bear","hawk","lynx","puma","crow","deer","dove","frog","hare",
    "kite","lark","mole","newt","orca","pike","quil","rook","swan","toad",
    "vole","wren","yak","ant","bass","crab","dusk","echo","flux","gale"];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = noun[Math.floor(Math.random() * noun.length)];
  return `${a}-${n}`;
}

export function getAwsProfiles(): string[] {
  try {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const { homedir } = require("os");
    const cfg = readFileSync(join(homedir(), ".aws", "config"), "utf-8");
    const profiles: string[] = [];
    for (const line of cfg.split("\n")) {
      const m = line.match(/^\[profile\s+(.+)\]$/);
      if (m) profiles.push(m[1]);
      else if (line.match(/^\[default\]$/)) profiles.push("default");
    }
    return profiles;
  } catch { return ["default"]; }
}

/** Format token count as human-readable (1.2K, 3.5M, etc.) */
export function humanTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

