/**
 * Docker Compose detection and lifecycle management for project sessions.
 * Detects compose files, starts/stops stacks, lists containers, and resolves ports.
 */

import { existsSync, readFileSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { COMPOSE_FILE_NAMES } from "../../arc-json.js";
import { logDebug } from "../../../core/observability/structured-log.js";

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
        logDebug("compute", "skip malformed lines");
      }
    }
    return names;
  } catch {
    return [];
  }
}

// ── Inline compose + multi-file variants (used by DockerComposeRuntime) ─────

/**
 * Serialize an inline compose spec to YAML and write it to `outPath`.
 * Parent directories are created on demand. Replaces any existing file.
 */
export async function writeInlineCompose(inline: Record<string, unknown>, outPath: string): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });
  const yaml = stringifyYaml(inline);
  await writeFile(outPath, yaml, { encoding: "utf-8" });
}

/** Run `docker compose -f <files> up -d` in a workdir. Paired with composeDownWithFiles. */
export async function composeUpWithFiles(workdir: string, files: string[]): Promise<{ ok: boolean; error?: string }> {
  if (files.length === 0) return { ok: false, error: "no compose files provided" };
  const args = ["compose", ...flagFiles(files), "up", "-d"];
  try {
    await execFileAsync("docker", args, { cwd: workdir });
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Paired `down` for composeUpWithFiles. Same `-f` set must be passed so
 *  compose resolves the same project name and stops every service. */
export async function composeDownWithFiles(workdir: string, files: string[]): Promise<{ ok: boolean; error?: string }> {
  if (files.length === 0) return { ok: false, error: "no compose files provided" };
  const args = ["compose", ...flagFiles(files), "down"];
  try {
    await execFileAsync("docker", args, { cwd: workdir });
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve the network name for a compose project in `workdir`. Docker
 * Compose names the default network `<project>_default`; the project name
 * defaults to the basename of the workdir but can be overridden by
 * `COMPOSE_PROJECT_NAME` or `-p`.
 *
 * We prefer `docker compose ls --format json` (reliable, machine-readable)
 * and fall back to the workdir basename if the lookup fails.
 */
export async function resolveComposeNetwork(workdir: string, files?: string[]): Promise<string> {
  const args = ["compose"];
  if (files && files.length > 0) args.push(...flagFiles(files));
  args.push("ls", "--format", "json", "--all");
  try {
    const { stdout } = await execFileAsync("docker", args, { cwd: workdir, encoding: "utf-8" });
    const entries = safeParseComposeLs(stdout);
    // docker compose ls reports ConfigFiles as an absolute path; match on cwd.
    for (const entry of entries) {
      const configFiles = typeof entry.ConfigFiles === "string" ? entry.ConfigFiles.split(",") : [];
      const hit = configFiles.some((p) => dirname(p) === workdir);
      if (hit && typeof entry.Name === "string" && entry.Name.length > 0) {
        return `${entry.Name}_default`;
      }
    }
  } catch {
    logDebug("compute", "fall through to basename heuristic");
  }
  return `${defaultComposeProjectName(workdir)}_default`;
}

/** Returns the default compose project name for a given workdir. */
export function defaultComposeProjectName(workdir: string): string {
  // Compose lowercases + strips characters outside [a-z0-9_-]. Match that
  // behaviour so our fallback lines up with what compose actually creates.
  return basename(workdir)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

function flagFiles(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    out.push("-f", f);
  }
  return out;
}

function safeParseComposeLs(stdout: string): Array<{ Name?: string; ConfigFiles?: string }> {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  // docker compose ls --format json emits a single JSON array (not ndjson).
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    logDebug("compute", "fall through to ndjson");
  }
  const out: Array<{ Name?: string; ConfigFiles?: string }> = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      logDebug("compute", "skip malformed");
    }
  }
  return out;
}

// ── Legacy single-file helpers (retained for existing callers) ──────────────

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
