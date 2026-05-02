/**
 * DockerComposeIsolation -- isolation backed by docker compose.
 *
 * Provisions a session by:
 *   1. Bringing up the user's docker-compose stack (file, inline, or both).
 *   2. Creating a sidecar arkd container joined to the compose network.
 *   3. Bootstrapping the sidecar and starting arkd so the agent can reach
 *      user services by compose service name.
 *
 * The stack may come from three forms declared in the repo's arc.json:
 *   - `compose: true`               -> docker-compose.yml in the repo
 *   - `compose: { file: "..." }`    -> custom path
 *   - `compose: { inline: {...} }`  -> spec written to a tempfile
 *   - `compose: { file, inline }`   -> both, merged via `docker compose -f A -f B`
 *
 * See `.workflow/plan/compute-runtime-vision.md` and the README for the
 * rationale behind the split.
 */

import { rmSync, existsSync } from "fs";
import { isAbsolute, join, resolve as pathResolve } from "path";

import { ArkdClient } from "../../arkd/client.js";
import type { AppContext } from "../../core/app.js";
import { allocatePort } from "../../core/config/port-allocator.js";
import { safeAsync } from "../../core/safe.js";
import { parseArcJson, resolveArcCompose } from "../arc-json.js";
import type { ArcComposeConfig } from "../types.js";
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
import {
  composeDownWithFiles,
  composeUpWithFiles,
  resolveComposeNetwork,
  writeInlineCompose,
} from "../providers/docker/compose.js";
import { logDebug } from "../../core/observability/structured-log.js";

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
  writeInlineCompose?: typeof writeInlineCompose;
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
  inlineTempPath: string | null;
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
    const arc = parseArcJson(workdir);
    const composeCfg = resolveArcCompose(arc);

    if (!composeCfg) {
      throw new Error(
        `DockerComposeIsolation.prepare: no compose config found in ${workdir}/arc.json. ` +
          `Set "compose": true, "compose": { "file": "..." } or "compose": { "inline": {...} }.`,
      );
    }

    const arkSource = (this.hooks.resolveArkSourceRoot ?? resolveArkSourceRoot)();
    if (!arkSource) {
      throw new Error(
        "Cannot locate ark source tree on host. DockerComposeIsolation needs the ark repo mounted at /opt/ark; " +
          "run from a source checkout.",
      );
    }

    const composeFiles = await this.buildComposeFileList(workdir, composeCfg, handle);
    const inlineTempPath = composeFiles.find((p) => p.includes("compose.inline.")) ?? null;

    const allocate = this.hooks.allocatePort ?? allocatePort;
    const arkdHostPort = await allocate();
    const arkdUrl = `http://localhost:${arkdHostPort}`;
    const containerName = `ark-${handle.name}-compose`;

    // 1. Bring the compose stack up (unless the user asked us not to).
    if (!composeCfg.skipUp) {
      const up = await (this.hooks.composeUpWithFiles ?? composeUpWithFiles)(workdir, composeFiles);
      if (!up.ok) {
        this.cleanupInlineTemp(inlineTempPath);
        throw new Error(`docker compose up failed: ${up.error ?? "unknown"}`);
      }
    }

    // 2. Resolve the compose network so the sidecar can join it.
    const composeNetwork = await (this.hooks.resolveComposeNetwork ?? resolveComposeNetwork)(workdir, composeFiles);

    // 3. Sidecar container. Rolled back via composeDown + inline tempfile on any failure.
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
      // Roll back in reverse order: sidecar first, then compose stack,
      // then the inline tempfile. Every step is best-effort so we surface
      // the original error rather than burying it behind cleanup noise.
      await safeAsync(`[compose] cleanup: rm sidecar ${containerName}`, async () => {
        await (this.hooks.removeContainer ?? removeContainer)(containerName);
      });
      if (!composeCfg.skipUp) {
        await safeAsync(`[compose] cleanup: compose down`, async () => {
          await (this.hooks.composeDownWithFiles ?? composeDownWithFiles)(workdir, composeFiles);
        });
      }
      this.cleanupInlineTemp(inlineTempPath);
      throw err;
    }

    const meta: DockerComposeMeta = {
      containerName,
      arkdHostPort,
      arkdUrl,
      composeFiles,
      composeNetwork,
      inlineTempPath,
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

    // 3. Delete the inline tempfile if we wrote one.
    this.cleanupInlineTemp(meta.inlineTempPath);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Build the ordered list of `-f` files for `docker compose`. Compose
   * applies later `-f` arguments as overrides, so we pass the user's file
   * first and the inline override second, matching compose's native merge.
   */
  private async buildComposeFileList(workdir: string, cfg: ArcComposeConfig, handle: ComputeHandle): Promise<string[]> {
    const files: string[] = [];

    if (cfg.file) {
      const abs = isAbsolute(cfg.file) ? cfg.file : pathResolve(workdir, cfg.file);
      if (!existsSync(abs)) {
        throw new Error(`DockerComposeIsolation.prepare: compose file not found: ${abs}`);
      }
      files.push(abs);
    }

    if (cfg.inline) {
      const runtimeDir = this.runtimeDir(handle);
      const tempPath = join(runtimeDir, `compose.inline.${Date.now()}.yml`);
      await (this.hooks.writeInlineCompose ?? writeInlineCompose)(cfg.inline, tempPath);
      files.push(tempPath);
    }

    if (files.length === 0) {
      throw new Error(`DockerComposeIsolation.prepare: compose config has neither file nor inline spec`);
    }
    return files;
  }

  private runtimeDir(handle: ComputeHandle): string {
    return join(this.app.config.dirs.ark, "runtime", handle.name);
  }

  private resolveSidecarImage(handle: ComputeHandle): string {
    const cfg = (handle.meta ?? {}) as Record<string, unknown>;
    return (cfg.image as string) || DEFAULT_IMAGE;
  }

  private resolveBootstrapOpts(handle: ComputeHandle): BootstrapOpts {
    const cfg = (handle.meta ?? {}) as Record<string, unknown>;
    return ((cfg.bootstrap as BootstrapOpts) ?? {}) as BootstrapOpts;
  }

  private cleanupInlineTemp(path: string | null): void {
    if (!path) return;
    try {
      rmSync(path, { force: true });
    } catch {
      logDebug("compute", "best-effort cleanup");
    }
  }
}

async function defaultConnectNetwork(networkName: string, containerName: string): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("docker", ["network", "connect", networkName, containerName], { timeout: 15_000 });
}
