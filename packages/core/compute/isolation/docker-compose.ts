/**
 * DockerComposeIsolation -- isolation backed by docker compose.
 *
 * Provisions a session by:
 *   1. Bringing up the user's docker-compose stack via the workspace's
 *      `docker-compose.yml` (or any of the standard compose filename
 *      variants).
 *   2. Creating a sidecar arkd container joined to the compose network.
 *   3. Bootstrapping the sidecar and starting arkd so the agent can reach
 *      user services by compose service name.
 *
 * The compose file is auto-detected: if `docker-compose.yml` (or any of the
 * variants in `COMPOSE_FILE_NAMES`) exists at the workspace root, this
 * isolation uses it; otherwise `prepare()` throws a clear error.
 *
 * See `.workflow/plan/compute-runtime-vision.md` and the README for the
 * rationale behind the split.
 */

import { existsSync, readFileSync } from "fs";

import { ArkdClient } from "../../../arkd/client/index.js";
import type { AppContext } from "../../app.js";
import { allocatePort } from "../../config/port-allocator.js";
import { safeAsync } from "../../safe.js";
import type {
  AgentHandle,
  Compute,
  ComputeHandle,
  IsolationKind,
  Isolation,
  LaunchOpts,
  PrepareCtx,
} from "../core/types.js";
import {
  bootstrapContainer,
  createContainer,
  DEFAULT_IMAGE,
  pullImage,
  removeContainer,
  resolveArkSourceRoot,
  startArkdInContainer,
  startContainer,
  stopContainer,
  waitForArkdHealth,
  type BootstrapOpts,
} from "../providers/docker/helpers.js";
import { composeDownWithFiles, composeUpWithFiles, resolveComposeNetwork } from "../providers/docker/compose.js";
import { parse as parseYaml } from "yaml";

import type { PortDecl } from "./devcontainer.js";

// ── Compose file detection ─────────────────────────────────────────────────

/** Canonical compose filename precedence; matches docker compose's own. */
const COMPOSE_FILE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] as const;

/**
 * Locate the compose file in `workdir`, picking the first name in
 * `COMPOSE_FILE_NAMES` that exists. Returns the absolute path, or null when
 * the workspace does not declare a compose stack.
 */
export function findComposeFile(workdir: string): string | null {
  for (const name of COMPOSE_FILE_NAMES) {
    const path = `${workdir}/${name}`;
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Read service-level `ports:` declarations from the workspace's compose file.
 * Returns an empty array when no compose file is present, the file is
 * unparseable, or no service declares `ports`.
 *
 * Each compose entry can be a number (`8080`), a string (`"3000:3000"`,
 * `"127.0.0.1:3000:3000"`, `"3000/tcp"`), or a long-form object with
 * `target`. We collect the host-facing port; protocol and label are not
 * propagated yet (none of our consumers need them).
 */
export function discoverComposePorts(workdir: string): PortDecl[] {
  const path = findComposeFile(workdir);
  if (!path) return [];
  try {
    const parsed = parseYaml(readFileSync(path, "utf-8"));
    const services = (parsed as { services?: Record<string, unknown> } | null)?.services ?? {};
    const out: PortDecl[] = [];
    for (const svc of Object.values(services)) {
      const ports = Array.isArray((svc as { ports?: unknown[] })?.ports) ? (svc as { ports: unknown[] }).ports : [];
      for (const entry of ports) {
        const port = parseComposePort(entry);
        if (port !== null) out.push({ port, source: "docker-compose" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function parseComposePort(entry: unknown): number | null {
  if (typeof entry === "number") return Number.isInteger(entry) ? entry : null;
  if (typeof entry === "string") {
    // Compose short syntax: extract the HOST-facing port. Supported forms:
    //   "3000"                       -- only one number, that IS the host port
    //   "8080:3000"                  -- host:container, take 8080
    //   "127.0.0.1:8080:3000"        -- ip:host:container, take 8080
    //   "3000/tcp"                   -- bare port + proto, take 3000
    //   "8080:3000/udp"              -- mapped + proto, take 8080
    // Range forms ("3000-3005:3000-3005") are not supported -- ignore them.
    if (entry.includes("-")) return null;
    const stripped = entry.split("/")[0];
    const parts = stripped.split(":");
    // host port is the second-to-last segment when there's a mapping,
    // otherwise the only segment.
    const host = parts.length === 1 ? parts[0] : parts[parts.length - 2];
    if (!host || !/^\d+$/.test(host)) return null;
    return parseInt(host, 10);
  }
  if (typeof entry === "object" && entry && "published" in entry) {
    const p = (entry as { published?: unknown }).published;
    if (typeof p === "number") return Number.isInteger(p) ? p : null;
    if (typeof p === "string" && /^\d+$/.test(p)) return parseInt(p, 10);
  }
  if (typeof entry === "object" && entry && "target" in entry) {
    // Long-form without `published` falls back to `target` (container port);
    // it's the only port we have. Compose treats this as published == target.
    const t = (entry as { target?: unknown }).target;
    return typeof t === "number" ? t : null;
  }
  return null;
}

// ── Test seams ──────────────────────────────────────────────────────────────
//
// Docker interactions are routed through a small hook surface so unit tests
// can swap in stubs without touching the filesystem or shelling out.

export interface DockerComposeIsolationHooks {
  pullImage?: (image: string) => Promise<void>;
  createContainer?: typeof createContainer;
  startContainer?: (name: string) => Promise<void>;
  stopContainer?: (name: string) => Promise<void>;
  removeContainer?: (name: string) => Promise<void>;
  bootstrapContainer?: (name: string, opts: BootstrapOpts) => Promise<void>;
  startArkdInContainer?: (name: string, conductorUrl: string) => Promise<void>;
  waitForArkdHealth?: (url: string, timeoutMs?: number) => Promise<void>;
  composeUpWithFiles?: typeof composeUpWithFiles;
  composeDownWithFiles?: typeof composeDownWithFiles;
  resolveComposeNetwork?: typeof resolveComposeNetwork;
  connectNetwork?: (networkName: string, containerName: string) => Promise<void>;
  allocatePort?: () => Promise<number>;
  resolveArkSourceRoot?: () => string | null;
}

// ── Isolation ───────────────────────────────────────────────────────────────

/**
 * State persisted on `handle.meta.dockerCompose` so `shutdown` can undo
 * whatever `prepare` did. Stored as a plain object because handles round-trip
 * through JSON.
 */
export interface DockerComposeMeta {
  containerName: string;
  arkdHostPort: number;
  arkdUrl: string;
  composeFiles: string[];
  composeNetwork: string;
  workdir: string;
}

export class DockerComposeIsolation implements Isolation {
  readonly kind: IsolationKind = "compose";
  readonly name = "docker-compose";

  private clientFactory: ((url: string) => ArkdClient) | null = null;
  private hooks: DockerComposeIsolationHooks;

  constructor(
    private readonly app: AppContext,
    hooks: DockerComposeIsolationHooks = {},
  ) {
    this.hooks = hooks;
  }

  /** Test-only: swap in a stub `ArkdClient` factory. */
  setClientFactory(factory: (url: string) => ArkdClient): void {
    this.clientFactory = factory;
  }

  /** Test-only: merge in additional hook overrides. */
  setHooks(hooks: DockerComposeIsolationHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  // ── prepare ────────────────────────────────────────────────────────────

  async prepare(_compute: Compute, handle: ComputeHandle, ctx: PrepareCtx): Promise<void> {
    const workdir = ctx.workdir;
    const composeFile = findComposeFile(workdir);

    if (!composeFile) {
      throw new Error(
        `DockerComposeIsolation.prepare: no docker-compose.yml found in ${workdir}. ` +
          `Expected one of: ${COMPOSE_FILE_NAMES.join(", ")}.`,
      );
    }

    const arkSource = (this.hooks.resolveArkSourceRoot ?? resolveArkSourceRoot)();
    if (!arkSource) {
      throw new Error(
        "Cannot locate ark source tree on host. DockerComposeIsolation needs the ark repo mounted at /opt/ark; " +
          "run from a source checkout.",
      );
    }

    const composeFiles = [composeFile];

    const allocate = this.hooks.allocatePort ?? allocatePort;
    const arkdHostPort = await allocate();
    const arkdUrl = `http://localhost:${arkdHostPort}`;
    const containerName = `ark-${handle.name}-compose`;

    // 1. Bring the compose stack up.
    const up = await (this.hooks.composeUpWithFiles ?? composeUpWithFiles)(workdir, composeFiles);
    if (!up.ok) {
      throw new Error(`docker compose up failed: ${up.error ?? "unknown"}`);
    }

    // 2. Resolve the compose network so the sidecar can join it.
    const composeNetwork = await (this.hooks.resolveComposeNetwork ?? resolveComposeNetwork)(workdir, composeFiles);

    // 3. Sidecar container. Rolled back via composeDown on any failure.
    const image = this.resolveSidecarImage(handle);
    const bootstrapOpts = this.resolveBootstrapOpts(handle);

    try {
      await (this.hooks.pullImage ?? pullImage)(image);
      await (this.hooks.createContainer ?? createContainer)(containerName, image, {
        arkDir: this.app.config.dirs.ark,
        arkSource,
        workdir,
        arkdHostPort,
      });
      await (this.hooks.startContainer ?? startContainer)(containerName);
      // Join the compose network so the sidecar can reach services by name.
      await (this.hooks.connectNetwork ?? defaultConnectNetwork)(composeNetwork, containerName);

      await (this.hooks.bootstrapContainer ?? bootstrapContainer)(containerName, bootstrapOpts);

      const conductorUrl = `http://host.docker.internal:${this.app.config.ports.conductor}`;
      await (this.hooks.startArkdInContainer ?? startArkdInContainer)(containerName, conductorUrl);
      await (this.hooks.waitForArkdHealth ?? waitForArkdHealth)(arkdUrl, 30_000);
    } catch (err) {
      // Roll back in reverse order: sidecar first, then compose stack. Every
      // step is best-effort so we surface the original error rather than
      // burying it behind cleanup noise.
      await safeAsync(`[compose] cleanup: rm sidecar ${containerName}`, async () => {
        await (this.hooks.removeContainer ?? removeContainer)(containerName);
      });
      await safeAsync(`[compose] cleanup: compose down`, async () => {
        await (this.hooks.composeDownWithFiles ?? composeDownWithFiles)(workdir, composeFiles);
      });
      throw err;
    }

    const meta: DockerComposeMeta = {
      containerName,
      arkdHostPort,
      arkdUrl,
      composeFiles,
      composeNetwork,
      workdir,
    };
    // Handle.meta is readonly on the interface but it's a plain object at runtime.
    (handle.meta as Record<string, unknown>).dockerCompose = meta;
  }

  // ── launchAgent ────────────────────────────────────────────────────────

  async launchAgent(compute: Compute, handle: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle> {
    const meta = handle.meta.dockerCompose as DockerComposeMeta | undefined;
    const url = meta?.arkdUrl ?? compute.getArkdUrl(handle);
    const client = this.clientFactory ? this.clientFactory(url) : new ArkdClient(url);
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: opts.launcherContent,
      workdir: opts.workdir,
    });
    return { sessionName: opts.tmuxName };
  }

  // ── shutdown ───────────────────────────────────────────────────────────

  async shutdown(_compute: Compute, handle: ComputeHandle): Promise<void> {
    const meta = handle.meta.dockerCompose as DockerComposeMeta | undefined;
    if (!meta) return;

    // 1. Stop + remove the sidecar.
    await safeAsync(`[compose] shutdown: stop ${meta.containerName}`, async () => {
      await (this.hooks.stopContainer ?? stopContainer)(meta.containerName);
    });
    await safeAsync(`[compose] shutdown: rm ${meta.containerName}`, async () => {
      await (this.hooks.removeContainer ?? removeContainer)(meta.containerName);
    });

    // 2. docker compose down. Tolerate failure -- the user may have torn
    //    the stack down out-of-band.
    await safeAsync(`[compose] shutdown: compose down`, async () => {
      await (this.hooks.composeDownWithFiles ?? composeDownWithFiles)(meta.workdir, meta.composeFiles);
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private resolveSidecarImage(handle: ComputeHandle): string {
    const cfg = (handle.meta ?? {}) as Record<string, unknown>;
    return (cfg.image as string) || DEFAULT_IMAGE;
  }

  private resolveBootstrapOpts(handle: ComputeHandle): BootstrapOpts {
    const cfg = (handle.meta ?? {}) as Record<string, unknown>;
    return ((cfg.bootstrap as BootstrapOpts) ?? {}) as BootstrapOpts;
  }
}

async function defaultConnectNetwork(networkName: string, containerName: string): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("docker", ["network", "connect", networkName, containerName], { timeout: 15_000 });
}
