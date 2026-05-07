/**
 * Normalize a project's `devcontainer.json` into a single flat shape that the
 * unified Docker compute provider consumes to spin up an arkd sidecar stack.
 *
 * This module is intentionally parse-only: it never talks to Docker, never
 * mutates the filesystem, and never runs user commands. The one exception is
 * `buildDevcontainerImage`, which shells out to `docker build` when the config
 * points at a Dockerfile. The resolution logic is pure and synchronous so it
 * can be exercised from unit tests without a Docker daemon.
 *
 * Supported devcontainer fields (see resolveDevcontainerShape for details):
 *   image, dockerFile, build.{dockerfile,context,args},
 *   dockerComposeFile + service, mounts, workspaceFolder, forwardPorts,
 *   postCreateCommand, features.
 *
 * Deferred (ignored; listed here so a follow-up can pick them up):
 *   onCreateCommand, postStartCommand, postAttachCommand,
 *   initializeCommand, remoteUser, containerUser, overrideCommand,
 *   shutdownAction, runArgs, containerEnv, remoteEnv, customizations,
 *   hostRequirements, updateContentCommand, waitFor.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import stripJsonComments from "strip-json-comments";

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────────────

export interface DevcontainerShape {
  /** Canonical docker image for the dev container (after build if dockerFile). */
  image: string | null;
  /** Path to a docker-compose.yml that defines the dev stack, if the devcontainer
   *  uses one via `dockerComposeFile`. Relative paths resolved to absolute. */
  composeFile: string | null;
  /** When composeFile is set, the name of the service the agent attaches to. */
  composeService: string | null;
  /** workspaceFolder inside the container. Default: /workspaces/<basename(workdir)>. */
  workspaceFolder: string;
  /** Extra mount specs from devcontainer.json `mounts` field, in docker -v format. */
  mounts: string[];
  /** Ports user wants forwarded; we'll add 19300 (arkd) when we consume this. */
  forwardPorts: number[];
  /** postCreateCommand (string or array form). Runs inside the container after boot. */
  postCreateCommand: string[] | null;
  /** Features map, preserved verbatim so a follow-up can support them. */
  features: Record<string, unknown>;
  /** The raw parsed devcontainer.json, for callers that want to peek at fields we did not normalize. */
  raw: Record<string, unknown>;
}

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Returns the absolute path of the devcontainer.json that applies to `workdir`,
 * or null if none exists. `.devcontainer/devcontainer.json` wins over a
 * top-level `.devcontainer.json`, matching VS Code's precedence.
 */
function detectDevcontainerPath(workdir: string): string | null {
  const candidates = [join(workdir, ".devcontainer", "devcontainer.json"), join(workdir, ".devcontainer.json")];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Returns null if no devcontainer.json is present under workdir. */
export function resolveDevcontainerShape(workdir: string): DevcontainerShape | null {
  const configPath = detectDevcontainerPath(workdir);
  if (!configPath) return null;

  const rawText = readFileSync(configPath, "utf-8");
  const raw = parseJsonc(rawText);
  if (!raw || typeof raw !== "object") {
    throw new Error(`devcontainer.json at ${configPath} did not parse to an object`);
  }

  const configDir = dirname(configPath);
  const shape: DevcontainerShape = {
    image: null,
    composeFile: null,
    composeService: null,
    workspaceFolder: defaultWorkspaceFolder(workdir),
    mounts: [],
    forwardPorts: [],
    postCreateCommand: null,
    features: {},
    raw,
  };

  // ── dockerComposeFile wins over image/build ────────────────────────────────
  //
  // The devcontainer spec is explicit: when dockerComposeFile is present, the
  // compose stack is authoritative and image/dockerFile/build are ignored.
  // `service` picks which service the agent attaches to.
  if (raw.dockerComposeFile !== undefined && raw.dockerComposeFile !== null) {
    shape.composeFile = resolveComposeFile(raw.dockerComposeFile, configDir);
    if (typeof raw.service === "string" && raw.service.length > 0) {
      shape.composeService = raw.service;
    }
  } else if (typeof raw.image === "string" && raw.image.length > 0) {
    // Priority 1: user gave us a canonical image directly. Pass through.
    shape.image = raw.image;
  } else if (typeof raw.dockerFile === "string" && raw.dockerFile.length > 0) {
    // Priority 2: legacy top-level `dockerFile`. Relative to .devcontainer/.
    // Build happens lazily via buildDevcontainerImage; here we only record
    // that a build is needed by leaving `image` null.
  } else if (raw.build && typeof raw.build === "object") {
    // Priority 3: modern `build` block. Same deal: image stays null until
    // buildDevcontainerImage tags it.
  }

  // ── workspaceFolder ───────────────────────────────────────────────────────
  if (typeof raw.workspaceFolder === "string" && raw.workspaceFolder.length > 0) {
    shape.workspaceFolder = raw.workspaceFolder;
  }

  // ── mounts ────────────────────────────────────────────────────────────────
  if (Array.isArray(raw.mounts)) {
    for (const entry of raw.mounts) {
      const spec = normalizeMount(entry);
      if (spec) shape.mounts.push(spec);
    }
  }

  // ── forwardPorts ──────────────────────────────────────────────────────────
  //
  // NOTE: we deliberately do NOT inject 19300 (arkd) here. That's the caller's
  // job when it consumes the shape, so test fixtures stay truthful to the
  // source file.
  if (Array.isArray(raw.forwardPorts)) {
    for (const p of raw.forwardPorts) {
      if (typeof p === "number" && Number.isFinite(p)) {
        shape.forwardPorts.push(p);
      }
    }
  }

  // ── postCreateCommand ─────────────────────────────────────────────────────
  //
  // Devcontainer spec allows string (shell command), array (argv), or object
  // (map of named commands). We normalize the first two; the object form is
  // ignored for now (rare, and adds complexity a follow-up can take on).
  if (typeof raw.postCreateCommand === "string") {
    shape.postCreateCommand = ["bash", "-lc", raw.postCreateCommand];
  } else if (Array.isArray(raw.postCreateCommand)) {
    shape.postCreateCommand = raw.postCreateCommand.filter((x): x is string => typeof x === "string");
  }

  // ── features (preserved verbatim) ─────────────────────────────────────────
  if (raw.features && typeof raw.features === "object" && !Array.isArray(raw.features)) {
    shape.features = raw.features as Record<string, unknown>;
  }

  return shape;
}

/**
 * Build the image referenced by the devcontainer's `dockerFile` / `build`
 * field. No-op if the shape already has an `image` (meaning the user specified
 * `image` directly, or a previous call already populated it). Returns the
 * resolved image tag.
 *
 * Uses `docker build` via execFile. 10-minute timeout because cold builds
 * that compile native deps can take a while.
 */
export async function buildDevcontainerImage(workdir: string, shape: DevcontainerShape): Promise<string> {
  if (shape.image) return shape.image;

  // If this devcontainer points at a compose stack, there's nothing to build
  // at the shape level -- compose handles its own build. Callers shouldn't
  // invoke us in that branch, but we guard defensively.
  if (shape.composeFile) {
    throw new Error("buildDevcontainerImage: shape has composeFile; build via docker compose, not docker build");
  }

  const raw = shape.raw;
  const configPath = detectDevcontainerPath(workdir);
  if (!configPath) {
    throw new Error(`buildDevcontainerImage: no devcontainer.json found under ${workdir}`);
  }
  const configDir = dirname(configPath);
  const tag = `ark-devcontainer-${sanitizeTag(basename(workdir))}:latest`;

  let dockerfileRel: string | null = null;
  let contextDir = configDir;
  const buildArgs: Record<string, string> = {};

  if (typeof raw.dockerFile === "string" && raw.dockerFile.length > 0) {
    dockerfileRel = raw.dockerFile;
  } else if (raw.build && typeof raw.build === "object") {
    const b = raw.build as Record<string, unknown>;
    if (typeof b.dockerfile === "string" && b.dockerfile.length > 0) {
      dockerfileRel = b.dockerfile;
    }
    if (typeof b.context === "string" && b.context.length > 0) {
      contextDir = isAbsolute(b.context) ? b.context : resolve(configDir, b.context);
    }
    if (b.args && typeof b.args === "object" && !Array.isArray(b.args)) {
      for (const [k, v] of Object.entries(b.args as Record<string, unknown>)) {
        if (typeof v === "string") buildArgs[k] = v;
      }
    }
  }

  if (!dockerfileRel) {
    throw new Error(`buildDevcontainerImage: devcontainer.json has no dockerFile or build.dockerfile (${configPath})`);
  }

  const dockerfilePath = isAbsolute(dockerfileRel) ? dockerfileRel : resolve(configDir, dockerfileRel);

  const args = ["build", "-t", tag, "-f", dockerfilePath];
  for (const [k, v] of Object.entries(buildArgs)) {
    args.push("--build-arg", `${k}=${v}`);
  }
  args.push(contextDir);

  await execFileAsync("docker", args, { timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });

  shape.image = tag;
  return tag;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse devcontainer.json allowing // and /* *\/ comments (the `jsonc`
 * flavor VS Code uses). Falls back to plain JSON.parse after stripping.
 * Returns null (not throws) on non-object roots so the caller can decide.
 */
function parseJsonc(text: string): Record<string, unknown> | null {
  const cleaned = stripJsonComments(text, { trailingCommas: true });
  const parsed = JSON.parse(cleaned);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** Default workspace path: /workspaces/<basename(workdir)>, the VS Code default. */
function defaultWorkspaceFolder(workdir: string): string {
  return `/workspaces/${basename(workdir)}`;
}

/**
 * dockerComposeFile may be a string or an array of strings (compose file
 * overlay chain). We return the absolute path of the last entry -- compose's
 * merge semantics mean the last file wins for any given key, and the unified
 * provider will pass the full chain via `-f` in a follow-up. For the shape's
 * single-file slot, "last wins" mirrors compose's own merge.
 *
 * Relative paths resolve from the devcontainer.json's directory.
 */
function resolveComposeFile(input: unknown, configDir: string): string | null {
  const resolveOne = (p: string): string => (isAbsolute(p) ? p : resolve(configDir, p));
  if (typeof input === "string") {
    return input.length > 0 ? resolveOne(input) : null;
  }
  if (Array.isArray(input)) {
    const strings = input.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (strings.length === 0) return null;
    return resolveOne(strings[strings.length - 1]);
  }
  return null;
}

/**
 * Normalize a `mounts` entry into a single docker -v spec string.
 *
 * Spec forms supported:
 *   - "source=X,target=Y,type=bind"     (devcontainer string form)
 *   - { source, target, type? }         (devcontainer object form)
 *   - "X:Y" or "X:Y:ro"                 (plain docker -v form, passed through)
 *
 * Returns null for entries we don't know how to handle.
 */
function normalizeMount(entry: unknown): string | null {
  if (typeof entry === "string") {
    if (entry.length === 0) return null;
    if (entry.includes("source=") || entry.includes("target=")) {
      const parsed = parseMountKeyValueString(entry);
      if (!parsed) return null;
      return formatMount(parsed.source, parsed.target, parsed.type);
    }
    // Already in `-v src:dst[:mode]` shape. Pass through.
    return entry;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>;
    const source = typeof obj.source === "string" ? obj.source : null;
    const target = typeof obj.target === "string" ? obj.target : null;
    const type = typeof obj.type === "string" ? obj.type : undefined;
    if (!source || !target) return null;
    return formatMount(source, target, type);
  }
  return null;
}

/** Parse a `source=X,target=Y,type=Z` spec into its parts. */
function parseMountKeyValueString(spec: string): { source: string; target: string; type?: string } | null {
  const parts = spec.split(",");
  let source: string | null = null;
  let target: string | null = null;
  let type: string | undefined;
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "source" || k === "src") source = v;
    else if (k === "target" || k === "dst" || k === "destination") target = v;
    else if (k === "type") type = v;
  }
  if (!source || !target) return null;
  return { source, target, type };
}

/**
 * Emit a docker-style -v spec. For bind mounts we keep the src:dst form so the
 * caller can pass it straight to `docker run -v`. For volume mounts we encode
 * type via the three-field form, which docker accepts as `name:dst` plus a
 * separate `type` via `--mount`; callers that care can peek at shape.raw.
 */
function formatMount(source: string, target: string, type?: string): string {
  if (type && type !== "bind") {
    // Non-bind mounts (volume, tmpfs) still fit in -v form for "name:path".
    return `${source}:${target}`;
  }
  return `${source}:${target}`;
}

/** Docker tag names allow [a-zA-Z0-9_.-]. Replace anything else with `-`. */
function sanitizeTag(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe.toLowerCase() : "workdir";
}
