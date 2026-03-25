/**
 * arc.json parser - reads per-repo config for port declarations, sync files,
 * and compose/devcontainer flags. Also resolves ports from devcontainer.json
 * and docker-compose.yml.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { ArcJson, PortDecl } from "./types.js";

/** Compose file name candidates in priority order (shared with compose.ts). */
export const COMPOSE_FILE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;

// ── Public API ──────────────────────────────────────────────────────────────

/** Reads and parses arc.json from a repo directory. Returns null if missing. */
export function parseArcJson(repoDir: string): ArcJson | null {
  const filePath = join(repoDir, "arc.json");
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as ArcJson;
}

/** Returns true if the repo has a devcontainer config. */
export function hasDevcontainer(repoDir: string): boolean {
  return (
    existsSync(join(repoDir, ".devcontainer", "devcontainer.json")) ||
    existsSync(join(repoDir, ".devcontainer.json"))
  );
}

/** Returns true if the repo has a compose file. */
export function hasComposeFile(repoDir: string): boolean {
  return composeFilePath(repoDir) !== null;
}

/**
 * Combines ports from arc.json, devcontainer.json, and docker-compose.yml
 * with deduplication. arc.json declarations take priority.
 */
export function resolvePortDecls(repoDir: string): PortDecl[] {
  const seen = new Map<number, PortDecl>();

  // arc.json ports have highest priority - add first
  const arcJson = parseArcJson(repoDir);
  if (arcJson?.ports) {
    for (const p of arcJson.ports) {
      seen.set(p.port, { port: p.port, name: p.name, source: "arc.json" });
    }
  }

  // devcontainer.json ports
  const devPorts = parseDevcontainerPorts(repoDir);
  for (const port of devPorts) {
    if (!seen.has(port)) {
      seen.set(port, { port, source: "devcontainer.json" });
    }
  }

  // docker-compose ports
  const composePorts = parseComposePorts(repoDir);
  for (const port of composePorts) {
    if (!seen.has(port)) {
      seen.set(port, { port, source: "docker-compose" });
    }
  }

  return [...seen.values()];
}

// ── Private helpers ─────────────────────────────────────────────────────────

/**
 * Reads .devcontainer/devcontainer.json or .devcontainer.json and extracts
 * the forwardPorts array.
 */
function parseDevcontainerPorts(repoDir: string): number[] {
  const candidates = [
    join(repoDir, ".devcontainer", "devcontainer.json"),
    join(repoDir, ".devcontainer.json"),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    const raw = readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw);
    if (Array.isArray(json.forwardPorts)) {
      return json.forwardPorts.filter((p: unknown): p is number => typeof p === "number");
    }
  }

  return [];
}

/**
 * Reads docker-compose.yml/yaml or compose.yml/yaml and extracts port numbers
 * from "NNNN:NNNN" patterns via regex.
 */
function parseComposePorts(repoDir: string): number[] {
  const filePath = composeFilePath(repoDir);
  if (!filePath) return [];

  const raw = readFileSync(filePath, "utf-8");
  const ports: number[] = [];
  // Match patterns like "8080:8080", "3000:3000", etc.
  const regex = /["']?(\d+):(\d+)["']?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const hostPort = parseInt(match[1], 10);
    if (!ports.includes(hostPort)) {
      ports.push(hostPort);
    }
  }
  return ports;
}

/** Returns the path to the first compose file found, or null. */
function composeFilePath(repoDir: string): string | null {
  for (const name of COMPOSE_FILE_NAMES) {
    const p = join(repoDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
