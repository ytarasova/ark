/**
 * DockerIsolation -- isolation that launches agents inside a per-session
 * arkd-sidecar Docker container.
 *
 * Architecture (mirrors the current `LocalDockerProvider`, but split along
 * the `Compute` x `Isolation` axes):
 *   - The `Compute` owns the host (for `LocalCompute`: the host is always up).
 *   - The `Isolation` owns the per-session container: create, bootstrap, start
 *     arkd inside, health-check, then delegate agent launches to arkd via
 *     `ArkdClient`. On `shutdown` the container is stopped and removed.
 *
 * Port mapping: every isolation prepares a fresh loopback-bound host port
 * that maps to arkd's internal port inside the container. The URL is stored
 * on `handle.meta.docker.arkdUrl` and overrides the compute's default
 * `getArkdUrl` for all `launchAgent` calls.
 *
 * This file only implements the new `Isolation` interface. The legacy
 * `LocalDockerProvider` (same sidecar model, older abstraction) stays live
 * and untouched until dispatch flips over through the ComputeTarget adapter.
 */

import type { AppContext } from "../../core/app.js";
import { ArkdClient } from "../../arkd/client.js";
import { allocatePort } from "../../core/config/port-allocator.js";
import type {
  AgentHandle,
  Compute,
  ComputeHandle,
  IsolationKind,
  Isolation,
  LaunchOpts,
  PrepareCtx,
} from "../core/types.js";
import type { DockerIsolationConfig } from "./docker-config.js";
import {
  pullImage,
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  bootstrapContainer,
  startArkdInContainer,
  waitForArkdHealth,
  resolveArkSourceRoot,
  DEFAULT_IMAGE,
} from "../providers/docker/helpers.js";
import { logDebug } from "../../core/observability/structured-log.js";

/**
 * Injectable helper surface for tests. Production wiring passes the real
 * docker/helpers functions; tests swap in stubs that record calls and
 * trigger deterministic failures without touching `execFile` or `fetch`.
 */
export interface DockerIsolationHelpers {
  pullImage: typeof pullImage;
  createContainer: typeof createContainer;
  startContainer: typeof startContainer;
  stopContainer: typeof stopContainer;
  removeContainer: typeof removeContainer;
  bootstrapContainer: typeof bootstrapContainer;
  startArkdInContainer: typeof startArkdInContainer;
  waitForArkdHealth: typeof waitForArkdHealth;
  resolveArkSourceRoot: typeof resolveArkSourceRoot;
  allocatePort: () => Promise<number>;
}

const DEFAULT_HELPERS: DockerIsolationHelpers = {
  pullImage,
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  bootstrapContainer,
  startArkdInContainer,
  waitForArkdHealth,
  resolveArkSourceRoot,
  allocatePort,
};

/** Shape stored on `handle.meta.docker` after a successful `prepare`. */
export interface DockerHandleMeta {
  /** Container name actually created (`ark-rt-<compute>-<short-handle>`). */
  containerName: string;
  /** Host-side loopback port mapped to arkd-internal 19300. */
  arkdHostPort: number;
  /** Full arkd base URL reachable from the host. */
  arkdUrl: string;
  /** Image pulled + used. */
  image: string;
  /** Absolute path of the ark source tree mounted into the container. */
  arkSource: string;
  /** Temp files created on the host for this session; cleaned up on shutdown. */
  tempPaths: string[];
}

export class DockerIsolation implements Isolation {
  readonly kind: IsolationKind = "docker";
  readonly name = "docker";

  private helpers: DockerIsolationHelpers = DEFAULT_HELPERS;
  private clientFactory: ((url: string) => ArkdClient) | null = null;

  constructor(private readonly app: AppContext) {}

  /** Test-only: swap in stubbed docker helpers + a stub `ArkdClient`. */
  setHelpersForTesting(helpers: Partial<DockerIsolationHelpers>): void {
    this.helpers = { ...DEFAULT_HELPERS, ...helpers };
  }

  /** Test-only: swap in a stub `ArkdClient` factory. */
  setClientFactory(factory: (url: string) => ArkdClient): void {
    this.clientFactory = factory;
  }

  // ── Isolation lifecycle ────────────────────────────────────────────────

  async prepare(compute: Compute, h: ComputeHandle, ctx: PrepareCtx): Promise<void> {
    const cfg = this._readConfig(h, ctx);
    const image = cfg.image ?? DEFAULT_IMAGE;
    const extraVolumes = cfg.volumes ?? [];
    const bootstrapOpts = cfg.bootstrap ?? {};

    const arkSource = this.helpers.resolveArkSourceRoot();
    if (!arkSource) {
      throw new Error(
        "DockerIsolation: cannot locate ark source tree on host. The arkd-sidecar " +
          "container needs the repo root mounted at /opt/ark. Run from a source " +
          "checkout or set ARK_SOURCE_ROOT.",
      );
    }

    const containerName = this._containerName(compute, h);
    const arkdHostPort = await this.helpers.allocatePort();
    const arkdUrl = `http://localhost:${arkdHostPort}`;

    // Track progress so we can clean up on partial failure.
    let created = false;

    try {
      await this.helpers.pullImage(image);

      await this.helpers.createContainer(containerName, image, {
        extraVolumes,
        arkDir: this.app.config.dirs.ark,
        arkSource,
        workdir: ctx.workdir,
        arkdHostPort,
      });
      created = true;

      await this.helpers.startContainer(containerName);

      // Bootstrap is idempotent; callers with a pre-built image set
      // `bootstrap: { skip: true }` to short-circuit.
      await this.helpers.bootstrapContainer(containerName, bootstrapOpts);

      // Point arkd at the host's conductor. Docker Desktop exposes the host
      // at host.docker.internal; Linux users on default bridge networking
      // rely on --add-host (not configured here yet) or a loopback route.
      const conductorUrl = `http://host.docker.internal:${this.app.config.ports.conductor}`;
      await this.helpers.startArkdInContainer(containerName, conductorUrl);
      await this.helpers.waitForArkdHealth(arkdUrl, 30_000);
    } catch (err) {
      // Best-effort teardown of a partially-created container. We never want
      // to leak a dangling `ark-rt-*` container on failure.
      if (created) {
        try {
          await this.helpers.removeContainer(containerName);
        } catch {
          logDebug("compute", "swallow -- primary error already in flight");
        }
      }
      throw err;
    }

    const meta: DockerHandleMeta = {
      containerName,
      arkdHostPort,
      arkdUrl,
      image,
      arkSource,
      tempPaths: [],
    };
    // Stash under `handle.meta.docker` so `launchAgent` / `shutdown` can find it.
    (h.meta as Record<string, unknown>).docker = meta;
  }

  async launchAgent(_compute: Compute, h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle> {
    const meta = this._readMeta(h);
    const client = this.clientFactory ? this.clientFactory(meta.arkdUrl) : new ArkdClient(meta.arkdUrl);
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: opts.launcherContent,
      workdir: opts.workdir,
    });
    return { sessionName: opts.tmuxName };
  }

  async shutdown(_compute: Compute, h: ComputeHandle): Promise<void> {
    const meta = (h.meta as Record<string, unknown>).docker as DockerHandleMeta | undefined;
    if (!meta) {
      // prepare never ran (or failed before the meta was written); nothing to do.
      return;
    }

    // Stop + remove are both best-effort: a manual `docker rm -f` or a crash
    // inside the container shouldn't prevent the handle from being retired.
    try {
      await this.helpers.stopContainer(meta.containerName);
    } catch {
      logDebug("compute", "already stopped, or container vanished -- proceed to rm");
    }
    try {
      await this.helpers.removeContainer(meta.containerName);
    } catch {
      logDebug("compute", "already gone");
    }

    // Clean up any host-side temp files the isolation staged. Empty today;
    // kept so future helpers (tarball copy, devcontainer build cache) have
    // a hook without a schema break.
    if (meta.tempPaths.length > 0) {
      const { rmSync } = await import("fs");
      for (const p of meta.tempPaths) {
        try {
          rmSync(p, { force: true, recursive: true });
        } catch {
          logDebug("compute", "best-effort");
        }
      }
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private _containerName(compute: Compute, h: ComputeHandle): string {
    // Per-handle suffix so multiple sessions on one compute don't collide.
    // Keep it short -- docker caps names at 253 chars but practical limit is
    // lower once combined with image tags in ps output.
    const suffix = h.name || compute.kind;
    return `ark-rt-${suffix}`;
  }

  private _readConfig(h: ComputeHandle, ctx: PrepareCtx): DockerIsolationConfig {
    // Precedence: explicit PrepareCtx.config (per-session) > compute handle meta.
    const fromCtx = (ctx.config ?? {}) as DockerIsolationConfig;
    const fromHandle = (h.meta ?? {}) as DockerIsolationConfig;
    return {
      image: fromCtx.image ?? fromHandle.image,
      volumes: fromCtx.volumes ?? fromHandle.volumes,
      bootstrap: fromCtx.bootstrap ?? fromHandle.bootstrap,
      env: { ...(fromHandle.env ?? {}), ...(fromCtx.env ?? {}) },
    };
  }

  private _readMeta(h: ComputeHandle): DockerHandleMeta {
    const meta = (h.meta as Record<string, unknown>).docker as DockerHandleMeta | undefined;
    if (!meta) {
      throw new Error("DockerIsolation: handle.meta.docker missing -- prepare() was not called or failed");
    }
    return meta;
  }
}
