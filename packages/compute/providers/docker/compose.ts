/**
 * Docker Compose detection and lifecycle management for project sessions.
 * Detects compose files, starts/stops stacks, lists containers, and resolves ports.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { parse as parseYaml } from "yaml";
import { COMPOSE_FILE_NAMES } from "../../arc-json.js";

const execFileAsync = promisify(execFile);

// ── Public API ──────────────────────────────────────────────────────────────

/** Returns path to compose file if found, null otherwise. */
export function detectComposeFile(repoDir: string): string | null {
  for (const name of COMPOSE_FILE_NAMES) {
    const p = join(repoDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Runs `docker compose up -d` in the workdir. Returns success/failure. */
export async function composeUp(workdir: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync("docker", ["compose", "up", "-d"], {
      cwd: workdir,
    });
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Runs `docker compose down` in the workdir. Returns success/failure. */
export async function composeDown(workdir: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync("docker", ["compose", "down"], {
      cwd: workdir,
    });
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Runs `docker compose ps --format json` and returns container names. */
export async function composePs(workdir: string): Promise<string[]> {
  try {
    const { stdout: output } = await execFileAsync("docker", ["compose", "ps", "--format", "json"], {
      cwd: workdir,
      encoding: "utf-8",
    });

    if (!output.trim()) return [];

    // docker compose ps --format json outputs one JSON object per line
    const names: string[] = [];
    for (const line of output.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.Name) names.push(entry.Name);
      } catch {
        // skip malformed lines
      }
    }
    return names;
  } catch {
    return [];
  }
}

/** Parse compose file for exposed ports. Returns host port numbers. */
export function resolveComposePorts(repoDir: string): number[] {
  const filePath = detectComposeFile(repoDir);
  if (!filePath) return [];

  const raw = readFileSync(filePath, "utf-8");
  const doc = parseYaml(raw);
  if (!doc || typeof doc !== "object" || !doc.services) return [];

  const ports: number[] = [];

  for (const service of Object.values(doc.services) as Record<string, unknown>[]) {
    if (!Array.isArray(service.ports)) continue;

    for (const portEntry of service.ports) {
      const str = String(portEntry);
      const match = str.match(/^(\d+):(\d+)/);
      if (match) {
        const hostPort = parseInt(match[1], 10);
        if (!ports.includes(hostPort)) {
          ports.push(hostPort);
        }
      }
    }
  }

  return ports;
}
