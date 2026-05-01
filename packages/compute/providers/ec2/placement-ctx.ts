/**
 * EC2 placement context: medium-specific delivery of typed secrets to an
 * EC2 host over SSH (tunneled through SSM Session Manager).
 *
 * - writeFile: stages bytes to a local tmpdir, then pipes `tar c | ssh tar x`
 *   so file mode is preserved on the wire. A defence-in-depth chmod follows.
 * - appendFile: idempotently replaces a marker-keyed block in a remote file
 *   via a sed BEGIN/END deletion + base64 stream-append.
 * - setEnv / getEnv: accumulates env vars for the agent launcher.
 * - setProvisionerConfig: no-op for EC2 (no kubeconfig consumed).
 * - expandHome: rewrites "~/foo" to "/home/ubuntu/foo".
 *
 * Placers (in core/secrets/placers/*) consume this exclusively via the
 * PlacementCtx interface and never see ssh, tar, or sed directly.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { spawn } from "child_process";
import { sshExec as defaultSshExec, buildSsmProxyArgs, type SsmConnectOpts } from "./ssh.js";
import { shellEscape } from "./shell-escape.js";
import { REMOTE_HOME, REMOTE_USER } from "./constants.js";
import type { PlacementCtx } from "../../../core/secrets/placement-types.js";
import { logDebug, logInfo } from "../../../core/observability/structured-log.js";

export interface EC2PlacementCtxOpts {
  sshKeyPath: string;
  instanceId: string;
  region: string;
  awsProfile?: string;
}

/**
 * Injection seam for tests. The default `sshExec` here returns `Promise<string>`
 * (stdout) -- it wraps the real `sshExec` from ssh.ts which returns
 * `{ stdout, stderr, exitCode }`. Production placers don't consume the result.
 */
export interface EC2PlacementCtxDeps {
  sshExec: (keyPath: string, instanceId: string, cmd: string) => Promise<string>;
  /** Pipe local tar -> ssh stdin to deliver bytes at a remote path. */
  pipeTarToSsh: (tarArgs: string[], remoteCmd: string) => Promise<void>;
}

const defaultDeps = (opts: EC2PlacementCtxOpts): EC2PlacementCtxDeps => {
  const ssm: SsmConnectOpts = { region: opts.region, awsProfile: opts.awsProfile };
  return {
    sshExec: async (keyPath, instanceId, cmd) => {
      const { stdout } = await defaultSshExec(keyPath, instanceId, cmd, ssm);
      return stdout;
    },
    pipeTarToSsh: (tarArgs, remoteCmd) =>
      new Promise<void>((resolve, reject) => {
        const tar = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "inherit"] });
        const ssh = spawn(
          "ssh",
          [
            "-i",
            opts.sshKeyPath,
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            ...buildSsmProxyArgs(ssm),
            `${REMOTE_USER}@${opts.instanceId}`,
            remoteCmd,
          ],
          { stdio: ["pipe", "inherit", "inherit"] },
        );

        // Bookkeeping so a single failure (or a timeout) cleans up both procs
        // without throwing twice or letting an unhandled stream error kill the
        // parent process. EPIPE on `ssh.stdin` (when ssh dies first) is the
        // specific failure that was crashing the dispatcher daemon -- Node's
        // default stream-error behaviour is to exit the process unless every
        // stream has an `error` listener.
        let settled = false;
        const finish = (err?: Error): void => {
          if (settled) return;
          settled = true;
          try {
            if (!tar.killed) tar.kill("SIGTERM");
          } catch {
            /* tar already gone */
          }
          try {
            if (!ssh.killed) ssh.kill("SIGTERM");
          } catch {
            /* ssh already gone */
          }
          if (err) reject(err);
          else resolve();
        };

        // Process-level error / exit
        tar.on("error", finish);
        ssh.on("error", finish);
        tar.on("close", (code) => {
          if (code !== 0 && !settled) finish(new Error(`tar exit ${code}`));
          // tar code 0 just lets ssh close trigger resolve -- fall through.
        });
        ssh.on("close", (code) => {
          if (code === 0) finish();
          else finish(new Error(`ssh exit ${code}`));
        });

        // Stream-level error handlers MUST exist on every stream we touch.
        // Without these, EPIPE / ECONNRESET propagate as "unhandled error"
        // events and crash the parent process. We don't reject on them
        // directly -- the close handler above already produces a clean
        // reject with the exit code, which is more informative than EPIPE.
        const tarOut = tar.stdout;
        const sshIn = ssh.stdin;
        if (tarOut)
          tarOut.on("error", () => {
            /* surfaced via process close */
          });
        if (sshIn)
          sshIn.on("error", () => {
            /* surfaced via process close */
          });
        if (tarOut && sshIn) tarOut.pipe(sshIn);

        // Belt-and-braces timeout. The actual SSH hang case (SSM session
        // mid-stream stall) is the one that previously wedged the daemon.
        const timeoutMs = Number(process.env.ARK_PLACEMENT_TAR_TIMEOUT_MS ?? 60_000);
        const t = setTimeout(() => finish(new Error(`pipeTarToSsh timed out after ${timeoutMs}ms`)), timeoutMs);
        // unref so the timer doesn't block the process from exiting on
        // graceful shutdown.
        t.unref?.();
        // Clear timer once we've settled (resolved or rejected).
        const clearOnSettle = (): void => clearTimeout(t);
        tar.on("close", clearOnSettle);
        ssh.on("close", clearOnSettle);
      }),
  };
};

/**
 * Test-only factory: build an EC2PlacementCtx with injected deps so tests
 * can stub sshExec and pipeTarToSsh. Production callers should use the
 * EC2PlacementCtx constructor directly.
 */
export function _makeEC2PlacementCtx(opts: EC2PlacementCtxOpts & Partial<EC2PlacementCtxDeps>): EC2PlacementCtx {
  const baseOpts: EC2PlacementCtxOpts = {
    sshKeyPath: opts.sshKeyPath,
    instanceId: opts.instanceId,
    region: opts.region,
    awsProfile: opts.awsProfile,
  };
  const deps: EC2PlacementCtxDeps = {
    ...defaultDeps(baseOpts),
    ...(opts.sshExec ? { sshExec: opts.sshExec } : {}),
    ...(opts.pipeTarToSsh ? { pipeTarToSsh: opts.pipeTarToSsh } : {}),
  };
  return new EC2PlacementCtx(baseOpts, deps);
}

export class EC2PlacementCtx implements PlacementCtx {
  private readonly env: Record<string, string> = {};
  private readonly deps: EC2PlacementCtxDeps;

  constructor(
    private readonly opts: EC2PlacementCtxOpts,
    deps?: EC2PlacementCtxDeps,
  ) {
    this.deps = deps ?? defaultDeps(opts);
  }

  async writeFile(path: string, mode: number, bytes: Uint8Array): Promise<void> {
    const stage = mkdtempSync(join(tmpdir(), "ark-place-"));
    try {
      const dir = dirname(path);
      const base = basename(path);
      writeFileSync(join(stage, base), Buffer.from(bytes), { mode });
      const remoteCmd = `mkdir -p ${shellEscape(dir)} && tar x -C ${shellEscape(dir)}`;
      const tarArgs = ["c", "-C", stage, base];
      logInfo("compute", `[trace:writeFile] begin path=${path} bytes=${bytes.length}`);
      await this.deps.pipeTarToSsh(tarArgs, remoteCmd);
      logInfo("compute", `[trace:writeFile] tar-pipe done path=${path}`);
      // Defence-in-depth chmod (tar should preserve, but be explicit).
      await this.deps.sshExec(
        this.opts.sshKeyPath,
        this.opts.instanceId,
        `chmod ${mode.toString(8)} ${shellEscape(path)}`,
      );
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  async appendFile(path: string, marker: string, bytes: Uint8Array): Promise<void> {
    // The marker arg is taken verbatim as the BEGIN/END suffix.
    // So a marker of "ark:secret:BB_KEY" produces "# BEGIN ark:secret:BB_KEY"
    // and "# END ark:secret:BB_KEY" in the target file.
    const beginMarker = `# BEGIN ${marker}`;
    const endMarker = `# END ${marker}`;
    // Escape sed regex metacharacters in the markers so colons / dots / etc
    // in `marker` don't break the address pattern.
    const escapeForSed = (s: string) => s.replace(/[.[\]\\/^$*+?()|{}]/g, "\\$&");
    const begin = escapeForSed(beginMarker);
    const end = escapeForSed(endMarker);
    const dir = dirname(path);
    const encoded = Buffer.from(bytes).toString("base64");
    const cmd = [
      `mkdir -p ${shellEscape(dir)}`,
      `touch ${shellEscape(path)}`,
      `sed -i '/${begin}/,/${end}/d' ${shellEscape(path)}`,
      `printf %s ${shellEscape(encoded)} | base64 -d >> ${shellEscape(path)}`,
    ].join(" && ");
    await this.deps.sshExec(this.opts.sshKeyPath, this.opts.instanceId, cmd);
  }

  setEnv(key: string, value: string): void {
    this.env[key] = value;
  }

  setProvisionerConfig(_cfg: { kubeconfig?: Uint8Array }): void {
    logDebug("compute", "EC2 provisioner does not consume kubeconfig (no-op)");
  }

  expandHome(rel: string): string {
    return rel.startsWith("~/") ? `${REMOTE_HOME}/${rel.slice(2)}` : rel;
  }

  getEnv(): Record<string, string> {
    return { ...this.env };
  }
}
