/**
 * arc.json parser - reads per-repo config for port declarations, sync files,
 * and compose/devcontainer flags. Also resolves ports from devcontainer.json
 * and docker-compose.yml.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import stripJsonComments from "strip-json-comments";
import type { ArcComposeConfig, ArcDevcontainerConfig, ArcJson, PortDecl } from "./types.js";
import { logDebug } from "../core/observability/structured-log.js";

/** Compose file name candidates in priority order (shared with compose.ts). */
export const COMPOSE_FILE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] as const;

/** Default compose file used when arc.json `compose: true` is a bare boolean. */
export const DEFAULT_COMPOSE_FILE = "docker-compose.yml";

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Reads and parses arc.json from a repo directory. Returns null if missing.
 *
 * The raw JSON is normalized so callers see a consistent shape:
 *   - `compose: true`  ->  `{ file: "docker-compose.yml" }`
 *   - `compose: false` ->  omitted (undefined)
 *   - `compose: { ... }` is validated and passed through
 *   - `devcontainer: true`/`false` is similarly normalized
 *
 * Invalid compose/devcontainer shapes throw with a clear error so the user
 * gets told at load time, not when their session tries to launch.
 */
export function parseArcJson(repoDir: string): ArcJson | null {
  const filePath = join(repoDir, "arc.json");
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as ArcJson;
  return normalizeArcJson(parsed);
}

/**
 * Normalize an arc.json value. Exported so callers that receive an ArcJson
 * from elsewhere (tests, alternate config sources) can apply the same rules.
 */
export function normalizeArcJson(input: ArcJson): ArcJson {
  const out: ArcJson = { ...input };

  if ("compose" in input) {
    const normalized = normalizeCompose(input.compose);
    if (normalized === undefined) delete out.compose;
    else out.compose = normalized;
  }

  if ("devcontainer" in input) {
    const normalized = normalizeDevcontainer(input.devcontainer);
    if (normalized === undefined) delete out.devcontainer;
    else out.devcontainer = normalized;
  }

  return out;
}

/**
 * Resolve the compose config on arc.json to the concrete object form. Returns
 * null if compose is disabled / missing.
 */
export function resolveArcCompose(arc: ArcJson | null | undefined): ArcComposeConfig | null {
  if (!arc || arc.compose === undefined) return null;
  const normalized = normalizeCompose(arc.compose);
  if (!normalized || typeof normalized === "boolean") return null;
  return normalized;
}

// ── Private helpers ─────────────────────────────────────────────────────────

/**
 * Normalize the `compose` field. Returns:
 *   - undefined    when compose is disabled (missing / false / empty object)
 *   - ArcComposeConfig  otherwise.
 *
 * Throws TypeError on shapes we cannot interpret so the user is told early.
 */
function normalizeCompose(value: ArcJson["compose"]): ArcComposeConfig | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "boolean") {
    return value ? { file: DEFAULT_COMPOSE_FILE } : undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `arc.json "compose" must be a boolean or object, got ${Array.isArray(value) ? "array" : typeof value}`,
    );
  }

  const out: ArcComposeConfig = {};
  if (value.file !== undefined) {
    if (typeof value.file !== "string" || value.file.length === 0) {
      throw new TypeError(`arc.json "compose.file" must be a non-empty string`);
    }
    out.file = value.file;
  }
  if (value.inline !== undefined) {
    if (typeof value.inline !== "object" || Array.isArray(value.inline) || value.inline === null) {
      throw new TypeError(`arc.json "compose.inline" must be an object (compose spec)`);
    }
    out.inline = value.inline as Record<string, unknown>;
  }
  if (value.skipUp !== undefined) {
    if (typeof value.skipUp !== "boolean") {
      throw new TypeError(`arc.json "compose.skipUp" must be a boolean`);
    }
    out.skipUp = value.skipUp;
  }

  // Neither file nor inline -- treat as disabled rather than silently picking
  // docker-compose.yml. Users who want the default write `compose: true`.
  if (!out.file && !out.inline) return undefined;
  return out;
}

function normalizeDevcontainer(value: ArcJson["devcontainer"]): ArcDevcontainerConfig | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `arc.json "devcontainer" must be a boolean or object, got ${Array.isArray(value) ? "array" : typeof value}`,
    );
  }
  const out: ArcDevcontainerConfig = {};
  if (value.config !== undefined) {
    if (typeof value.config !== "string" || value.config.length === 0) {
      throw new TypeError(`arc.json "devcontainer.config" must be a non-empty string`);
    }
    out.config = value.config;
  }
  return out;
}

/** Returns true if the repo has a devcontainer config. */
export function hasDevcontainer(repoDir: string): boolean {
  return (
    existsSync(join(repoDir, ".devcontainer", "devcontainer.json")) || existsSync(join(repoDir, ".devcontainer.json"))
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
  const candidates = [join(repoDir, ".devcontainer", "devcontainer.json"), join(repoDir, ".devcontainer.json")];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const json = JSON.parse(stripJsonComments(raw));
      if (Array.isArray(json.forwardPorts)) {
        return json.forwardPorts.filter((p: unknown): p is number => typeof p === "number");
      }
    } catch {
      logDebug("compute", "invalid JSON -- skip");
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
