/**
 * DevcontainerIsolation -- isolation backed by devcontainer.json.
 *
 * Turns a project's `.devcontainer/devcontainer.json` into a provisioned,
 * arkd-hosting container that the conductor can reach over HTTP.
 *
 * Two branches (mirrored in `handle.meta.devcontainer.mode`):
 *
 *   "image":   devcontainer.json points at a single image / Dockerfile / build.
 *              We build (if needed) + create + bootstrap + start arkd ourselves,
 *              binding a loopback host port to 19300 inside. The devcontainer
 *              IS the sidecar.
 *
 *   "compose": devcontainer.json uses `dockerComposeFile` + `service`. The
 *              user's compose stack owns the containers; we `compose up -d`,
 *              find the agent service's container, bootstrap it via
 *              `docker exec`, start arkd inside, then spin up a tiny
 *              `alpine/socat` forwarder sidecar to expose arkd on a host
 *              loopback port.
 *
 * Forwarder rationale: compose-owned containers don't publish ports to the
 * host under our control, and Docker Desktop on macOS cannot route from the
 * host to container IPs. A sidecar that shares the compose network and
 * publishes `127.0.0.1:H:19300` works on both Linux and macOS with no
 * per-host detection.
 *
 * Features (`features: {...}` in devcontainer.json) are not installed yet.
 * `resolveDevcontainerShape` preserves them verbatim so a follow-up can pick
 * them up; we log a warning and move on.
 */

import { execFile } from "child_process";
import { promisify } from "util";

import { ArkdClient } from "../../../arkd/client/index.js";
import type { AppContext } from "../../app.js";
import { allocatePort } from "../../config/port-allocator.js";
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
  ARKD_INTERNAL_PORT,
  bootstrapContainer,
  createContainer,
  removeContainer,
  resolveArkSourceRoot,
  startArkdInContainer,
  startContainer,
  stopContainer,
  waitForArkdHealth,
} from "../providers/docker/helpers.js";
import {
  buildDevcontainerImage,
  resolveDevcontainerShape,
  type DevcontainerShape,
} from "../providers/docker/devcontainer-resolve.js";

const execFileAsync = promisify(execFile);

/** Stored under `handle.meta.devcontainer` so shutdown has everything it needs. */
export interface DevcontainerIsolationMeta {
  /** Which branch ran during prepare. */
  mode: "image" | "compose";
  /** Container we talk arkd to. For compose mode, the compose-owned container id. */
  containerName: string;
  /** Host loopback port where arkd is reachable. */
  arkdHostPort: number;
  /** http://127.0.0.1:<arkdHostPort>. */
  arkdUrl: string;
  /** Absolute path to docker-compose.yml for compose mode; null for image mode. */
  composeFile: string | null;
  /** Compose service name for compose mode; null for image mode. */
  composeService: string | null;
  /** Forwarder sidecar name, set only when we ran a socat forwarder. */
  forwarderName: string | null;
  /** The resolved shape used to drive this prepare. Kept for observability. */
  devcontainerShape: DevcontainerShape;
  /** Workdir used to spin this up (needed for `compose down` at shutdown). */
  workdir: string;
}

/** Injected surface so tests can stub docker / arkd without hitting the daemon. */
export interface DevcontainerIsolationDeps {
  /** Build a devcontainer image from a shape. Default: the real `buildDevcontainerImage`. */
  buildImage?(workdir: string, shape: DevcontainerShape): Promise<string>;
  /** Resolve shape from workdir. Default: `resolveDevcontainerShape`. */
  resolveShape?(workdir: string): DevcontainerShape | null;
  /** Allocate a free host port. Default: `allocatePort`. */
  allocatePort?(): Promise<number>;
  /** Create a persistent container (image mode). Default: `createContainer`. */
  createContainer?: typeof createContainer;
  /** Start an already-created container (image mode). Default: `startContainer`. */
  startContainer?: typeof startContainer;
  /** Stop a container. Default: `stopContainer`. */
  stopContainer?: typeof stopContainer;
  /** Force-remove a container. Default: `removeContainer`. */
  removeContainer?: typeof removeContainer;
  /** Install arkd deps inside a named container. Default: `bootstrapContainer`. */
  bootstrapContainer?: typeof bootstrapContainer;
  /** Kick arkd off in a named container. Default: `startArkdInContainer`. */
  startArkdInContainer?: typeof startArkdInContainer;
  /** Poll arkd's `/snapshot`. Default: `waitForArkdHealth`. */
  waitForArkdHealth?: typeof waitForArkdHealth;
  /** Find the local ark repo root to mount at /opt/ark. Default: `resolveArkSourceRoot`. */
  resolveArkSourceRoot?: typeof resolveArkSourceRoot;
  /** execFile wrapper -- used for compose + docker exec + socat forwarder. */
  execFile?: (
    cmd: string,
    args: string[],
    opts?: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Build an `ArkdClient` for a given URL. Default: new ArkdClient(url). */
  arkdClientFactory?(url: string): ArkdClient;
}

export class DevcontainerIsolation implements Isolation {
  readonly kind: IsolationKind = "devcontainer";
  readonly name = "devcontainer";

  private deps: Required<DevcontainerIsolationDeps>;

  constructor(
    private readonly app: AppContext,
    deps: DevcontainerIsolationDeps = {},
  ) {
    this.deps = {
      buildImage: deps.buildImage ?? buildDevcontainerImage,
      resolveShape: deps.resolveShape ?? resolveDevcontainerShape,
      allocatePort: deps.allocatePort ?? allocatePort,
      createContainer: deps.createContainer ?? createContainer,
      startContainer: deps.startContainer ?? startContainer,
      stopContainer: deps.stopContainer ?? stopContainer,
      removeContainer: deps.removeContainer ?? removeContainer,
      bootstrapContainer: deps.bootstrapContainer ?? bootstrapContainer,
      startArkdInContainer: deps.startArkdInContainer ?? startArkdInContainer,
      waitForArkdHealth: deps.waitForArkdHealth ?? waitForArkdHealth,
      resolveArkSourceRoot: deps.resolveArkSourceRoot ?? resolveArkSourceRoot,
      execFile:
        deps.execFile ??
        (async (cmd, args, opts) => {
          const { stdout, stderr } = await execFileAsync(cmd, args, opts as never);
          return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
        }),
      arkdClientFactory: deps.arkdClientFactory ?? ((url: string) => new ArkdClient(url)),
    };
  }

  /** Test-only: swap any subset of deps after construction. */
  setDeps(deps: DevcontainerIsolationDeps): void {
    this.deps = { ...this.deps, ...(deps as Required<DevcontainerIsolationDeps>) };
  }

  // ── prepare ──────────────────────────────────────────────────────────────

  async prepare(_compute: Compute, h: ComputeHandle, ctx: PrepareCtx): Promise<void> {
    const shape = this.deps.resolveShape(ctx.workdir);
    if (!shape) {
      throw new Error(
        `DevcontainerIsolation.prepare: no devcontainer.json found under ${ctx.workdir}. ` +
          `Expected .devcontainer/devcontainer.json or .devcontainer.json.`,
      );
    }

    if (Object.keys(shape.features).length > 0) {
      const names = Object.keys(shape.features).join(", ");
      ctx.onLog?.(`[devcontainer] warning: devcontainer features not yet supported, ignoring: ${names}`);
    }

    const conductorUrl = this.conductorUrl();

    if (shape.composeFile) {
      await this.prepareCompose(h, ctx, shape, conductorUrl);
    } else {
      await this.prepareImage(h, ctx, shape, conductorUrl);
    }
  }

  // ── Image branch ─────────────────────────────────────────────────────────

  private async prepareImage(
    h: ComputeHandle,
    ctx: PrepareCtx,
    shape: DevcontainerShape,
    conductorUrl: string,
  ): Promise<void> {
    const image = await this.deps.buildImage(ctx.workdir, shape);
    const containerName = this.imageContainerName(h.name);
    const arkdHostPort = await this.deps.allocatePort();
    const arkdUrl = `http://127.0.0.1:${arkdHostPort}`;

    await this.deps.createContainer(containerName, image, {
      extraVolumes: shape.mounts,
      arkDir: this.app.config.dirs.ark,
      workdir: ctx.workdir,
      arkSource: this.deps.resolveArkSourceRoot() ?? undefined,
      arkdHostPort,
    });

    try {
      await this.deps.startContainer(containerName);
      await this.deps.bootstrapContainer(containerName, {});

      if (shape.postCreateCommand && shape.postCreateCommand.length > 0) {
        await this.deps.execFile("docker", ["exec", "-i", containerName, ...shape.postCreateCommand], {
          timeout: 300_000,
          maxBuffer: 10 * 1024 * 1024,
        });
      }

      await this.deps.startArkdInContainer(containerName, conductorUrl);
      await this.deps.waitForArkdHealth(arkdUrl);
    } catch (err) {
      // Roll back the container we created so we don't leak one on partial
      // prepare failure. Best-effort: a failing cleanup must not mask the
      // original error.
      await this.safeRemove(containerName, ctx);
      throw err;
    }

    const meta: DevcontainerIsolationMeta = {
      mode: "image",
      containerName,
      arkdHostPort,
      arkdUrl,
      composeFile: null,
      composeService: null,
      forwarderName: null,
      devcontainerShape: shape,
      workdir: ctx.workdir,
    };
    (h.meta as Record<string, unknown>).devcontainer = meta;
  }

  // ── Compose branch ───────────────────────────────────────────────────────

  private async prepareCompose(
    h: ComputeHandle,
    ctx: PrepareCtx,
    shape: DevcontainerShape,
    conductorUrl: string,
  ): Promise<void> {
    if (!shape.composeFile) throw new Error("prepareCompose called without composeFile");
    const service = shape.composeService;
    if (!service) {
      throw new Error(
        `DevcontainerIsolation.prepare: devcontainer.json has dockerComposeFile but no "service" field. ` +
          `Ark needs to know which service the agent attaches to.`,
      );
    }

    // 1. Bring the stack up.
    await this.deps.execFile("docker", ["compose", "-f", shape.composeFile, "up", "-d"], {
      cwd: ctx.workdir,
      timeout: 300_000,
    });

    // 2. Find the running container id for the agent's service.
    const psResult = await this.deps.execFile("docker", ["compose", "-f", shape.composeFile, "ps", "-q", service], {
      cwd: ctx.workdir,
      timeout: 30_000,
    });
    const containerId = (psResult.stdout ?? "").trim().split("\n")[0]?.trim();
    if (!containerId) {
      throw new Error(
        `DevcontainerIsolation.prepare: docker compose ps found no container for service "${service}" ` +
          `in ${shape.composeFile}.`,
      );
    }

    // 3. Bootstrap + start arkd inside the compose-managed container. Because
    //    we didn't create it, we can't pass the sidecar mount set -- compose
    //    owns the container spec. Bootstrap still works (idempotent + only
    //    installs deps), and arkd runs from whatever path is available via
    //    /opt/ark if the user mounted the ark source, or falls back to bun
    //    being on PATH after bootstrap.
    await this.deps.bootstrapContainer(containerId, {});
    await this.deps.startArkdInContainer(containerId, conductorUrl);

    // 4. Forwarder sidecar: we need a host port → container:19300 path that
    //    works on macOS (Docker Desktop cannot route to container IPs). The
    //    sidecar joins the compose network and publishes 127.0.0.1:H:19300.
    const arkdHostPort = await this.deps.allocatePort();
    const forwarderName = this.forwarderName(h.name);
    const network = await this.resolveComposeNetwork(shape.composeFile, ctx.workdir, containerId);

    // alpine/socat listens on :19300 inside the sidecar and proxies to the
    // agent container on the shared network by container-id. `fork,reuseaddr`
    // handles multiple concurrent arkd requests without port reuse errors.
    await this.deps.execFile(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        forwarderName,
        "--network",
        network,
        "-p",
        `127.0.0.1:${arkdHostPort}:${ARKD_INTERNAL_PORT}`,
        "alpine/socat",
        `TCP-LISTEN:${ARKD_INTERNAL_PORT},fork,reuseaddr`,
        `TCP:${containerId}:${ARKD_INTERNAL_PORT}`,
      ],
      { timeout: 60_000 },
    );

    const arkdUrl = `http://127.0.0.1:${arkdHostPort}`;
    try {
      await this.deps.waitForArkdHealth(arkdUrl);
    } catch (err) {
      // Tear down what we set up so a retry isn't blocked by stale state.
      await this.safeRemove(forwarderName, ctx);
      await this.safeComposeDown(shape.composeFile, ctx.workdir, ctx);
      throw err;
    }

    const meta: DevcontainerIsolationMeta = {
      mode: "compose",
      containerName: containerId,
      arkdHostPort,
      arkdUrl,
      composeFile: shape.composeFile,
      composeService: service,
      forwarderName,
      devcontainerShape: shape,
      workdir: ctx.workdir,
    };
    (h.meta as Record<string, unknown>).devcontainer = meta;
  }

  // ── launchAgent ──────────────────────────────────────────────────────────

  async launchAgent(_compute: Compute, h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle> {
    const meta = this.getMeta(h);
    const client = this.deps.arkdClientFactory(meta.arkdUrl);
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: opts.launcherContent,
      workdir: opts.workdir,
    });
    return { sessionName: opts.tmuxName };
  }

  // ── shutdown ─────────────────────────────────────────────────────────────

  async shutdown(_compute: Compute, h: ComputeHandle): Promise<void> {
    const meta = (h.meta as Record<string, unknown>).devcontainer as DevcontainerIsolationMeta | undefined;
    if (!meta) return;

    // Order matters: forwarder first (it holds the host port), then
    // compose/container. Best-effort throughout so we don't leak on partial
    // failures.
    if (meta.forwarderName) {
      await this.safeRemove(meta.forwarderName);
    }

    if (meta.mode === "compose" && meta.composeFile) {
      await this.safeComposeDown(meta.composeFile, meta.workdir);
    } else if (meta.mode === "image") {
      // We created the container in prepare, so we own teardown.
      try {
        await this.deps.stopContainer(meta.containerName);
      } catch (err) {
        this.logShutdownError(`stop ${meta.containerName}`, err);
      }
      await this.safeRemove(meta.containerName);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private getMeta(h: ComputeHandle): DevcontainerIsolationMeta {
    const meta = (h.meta as Record<string, unknown>).devcontainer as DevcontainerIsolationMeta | undefined;
    if (!meta) {
      throw new Error("DevcontainerIsolation:handle has no devcontainer meta. Was prepare() called?");
    }
    return meta;
  }

  private conductorUrl(): string {
    return `http://localhost:${this.app.config.ports.conductor}`;
  }

  /** Deterministic name so repeated prepare/destroy cycles don't collide. */
  private imageContainerName(handleName: string): string {
    return `ark-dc-${sanitize(handleName)}`;
  }

  private forwarderName(handleName: string): string {
    return `ark-fwd-${sanitize(handleName)}`;
  }

  /**
   * Find the docker network to join the forwarder to. We prefer the first
   * network attached to the target container -- that's guaranteed to be the
   * compose-managed network when the target came from `compose up`.
   */
  private async resolveComposeNetwork(_composeFile: string, _workdir: string, containerId: string): Promise<string> {
    const { stdout } = await this.deps.execFile(
      "docker",
      ["inspect", "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}", containerId],
      { timeout: 15_000 },
    );
    const first = stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!first) {
      throw new Error(`DevcontainerIsolation:could not resolve compose network for container ${containerId}`);
    }
    return first;
  }

  private async safeRemove(name: string, ctx?: { onLog?: (msg: string) => void }): Promise<void> {
    try {
      await this.deps.removeContainer(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const line = `[devcontainer] rm ${name} failed (non-fatal): ${msg}`;
      if (ctx?.onLog) ctx.onLog(line);
      else this.logShutdownError(`rm ${name}`, err);
    }
  }

  private async safeComposeDown(
    composeFile: string,
    workdir: string,
    ctx?: { onLog?: (msg: string) => void },
  ): Promise<void> {
    try {
      await this.deps.execFile("docker", ["compose", "-f", composeFile, "down"], {
        cwd: workdir,
        timeout: 120_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const line = `[devcontainer] compose down ${composeFile} failed (non-fatal): ${msg}`;
      if (ctx?.onLog) ctx.onLog(line);
      else this.logShutdownError(`compose down ${composeFile}`, err);
    }
  }

  private logShutdownError(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    // Stderr rather than stdout so log aggregators pick it up as a warning.
    // No-op in production paths that redirect both; still useful in dev.
    console.warn(`[devcontainer] ${op} failed (non-fatal): ${msg}`);
  }
}

/** Docker object names: [a-zA-Z0-9][a-zA-Z0-9_.-]. */
function sanitize(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe.toLowerCase() : "handle";
}
