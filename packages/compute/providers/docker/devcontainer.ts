/**
 * Devcontainer support - detects, builds, and manages devcontainers for
 * project sessions. Wraps the `devcontainer` CLI.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Returns path to devcontainer.json if found, null otherwise.
 * Checks .devcontainer/devcontainer.json first, then .devcontainer.json.
 */
export function detectDevcontainer(repoDir: string): string | null {
  const candidates = [
    join(repoDir, ".devcontainer", "devcontainer.json"),
    join(repoDir, ".devcontainer.json"),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath)) return filePath;
  }

  return null;
}

// ── Build & Exec ────────────────────────────────────────────────────────────

/**
 * Runs `devcontainer up --workspace-folder <workdir>`.
 * Returns success/failure.
 */
export function buildDevcontainer(workdir: string): { ok: boolean; error?: string } {
  try {
    execFileSync("devcontainer", ["up", "--workspace-folder", workdir], {
      stdio: "pipe",
    });
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Runs `devcontainer exec --workspace-folder <workdir> -- <command>`.
 * Returns stdout and exit code.
 */
export function execInDevcontainer(
  workdir: string,
  command: string,
): { stdout: string; exitCode: number } {
  try {
    const output = execFileSync(
      "devcontainer",
      ["exec", "--workspace-folder", workdir, "--", "bash", "-c", command],
      { stdio: "pipe" },
    );
    return { stdout: output.toString(), exitCode: 0 };
  } catch (err: unknown) {
    const exitCode =
      err && typeof err === "object" && "status" in err
        ? (err as { status: number }).status
        : 1;
    const stdout =
      err && typeof err === "object" && "stdout" in err
        ? String((err as { stdout: Buffer }).stdout)
        : "";
    return { stdout, exitCode };
  }
}

// ── Launch command ──────────────────────────────────────────────────────────

/**
 * Returns a bash command string that:
 * 1. Runs `devcontainer up` to ensure the container is running
 * 2. Runs `devcontainer exec` to execute claudeArgs inside the container
 */
export function buildLaunchCommand(workdir: string, claudeArgs: string): string {
  const up = `devcontainer up --workspace-folder ${shellQuote(workdir)}`;
  const exec = `devcontainer exec --workspace-folder ${shellQuote(workdir)} -- bash -c ${shellQuote(claudeArgs)}`;
  return `${up} && ${exec}`;
}

// ── Port resolution ─────────────────────────────────────────────────────────

/**
 * Reads devcontainer.json and extracts the forwardPorts array.
 * Returns port numbers, or an empty array if no devcontainer config is found.
 */
export function resolveDevcontainerPorts(repoDir: string): number[] {
  const configPath = detectDevcontainer(repoDir);
  if (!configPath) return [];

  const raw = readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw);

  if (Array.isArray(json.forwardPorts)) {
    return json.forwardPorts.filter(
      (p: unknown): p is number => typeof p === "number",
    );
  }

  return [];
}

// ── Mount flags ─────────────────────────────────────────────────────────────

/**
 * Returns --mount flags for devcontainer exec to mount credential
 * directories into the container.
 */
export function devcontainerMounts(opts: {
  awsDir?: string;
  claudeDir?: string;
  sshDir?: string;
  gitconfig?: string;
}): string[] {
  const mounts: string[] = [];

  if (opts.awsDir) {
    mounts.push(
      "--mount",
      `type=bind,source=${opts.awsDir},target=/home/node/.aws`,
    );
  }

  if (opts.claudeDir) {
    mounts.push(
      "--mount",
      `type=bind,source=${opts.claudeDir},target=/home/node/.claude`,
    );
  }

  if (opts.sshDir) {
    mounts.push(
      "--mount",
      `type=bind,source=${opts.sshDir},target=/home/node/.ssh`,
    );
  }

  if (opts.gitconfig) {
    mounts.push(
      "--mount",
      `type=bind,source=${opts.gitconfig},target=/home/node/.gitconfig`,
    );
  }

  return mounts;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Simple shell quoting - wraps value in single quotes with escaping. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
