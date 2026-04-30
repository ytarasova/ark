/**
 * EC2 placement context: medium-specific delivery of typed secrets to an
 * EC2 host over SSH.
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
import { sshExec as defaultSshExec } from "./ssh.js";
import { shellEscape } from "./shell-escape.js";
import { REMOTE_HOME, REMOTE_USER } from "./constants.js";
import type { PlacementCtx } from "../../../core/secrets/placement-types.js";
import { logDebug } from "../../../core/observability/structured-log.js";

export interface EC2PlacementCtxOpts {
  sshKeyPath: string;
  ip: string;
}

/**
 * Injection seam for tests. The default `sshExec` here returns `Promise<string>`
 * (stdout) -- it wraps the real `sshExec` from ssh.ts which returns
 * `{ stdout, stderr, exitCode }`. Production placers don't consume the result.
 */
export interface EC2PlacementCtxDeps {
  sshExec: (keyPath: string, ip: string, cmd: string) => Promise<string>;
  /** Pipe local tar -> ssh stdin to deliver bytes at a remote path. */
  pipeTarToSsh: (tarArgs: string[], remoteCmd: string) => Promise<void>;
}

const defaultDeps = (opts: EC2PlacementCtxOpts): EC2PlacementCtxDeps => ({
  sshExec: async (keyPath, ip, cmd) => {
    const { stdout } = await defaultSshExec(keyPath, ip, cmd);
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
          `${REMOTE_USER}@${opts.ip}`,
          remoteCmd,
        ],
        { stdio: ["pipe", "inherit", "inherit"] },
      );
      tar.stdout!.pipe(ssh.stdin!);
      ssh.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ssh exit ${code}`))));
      tar.on("error", reject);
      ssh.on("error", reject);
    }),
});

/**
 * Test-only factory: build an EC2PlacementCtx with injected deps so tests
 * can stub sshExec and pipeTarToSsh. Production callers should use the
 * EC2PlacementCtx constructor directly.
 */
export function _makeEC2PlacementCtx(opts: EC2PlacementCtxOpts & Partial<EC2PlacementCtxDeps>): EC2PlacementCtx {
  const baseOpts: EC2PlacementCtxOpts = { sshKeyPath: opts.sshKeyPath, ip: opts.ip };
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
      await this.deps.pipeTarToSsh(tarArgs, remoteCmd);
      // Defence-in-depth chmod (tar should preserve, but be explicit).
      await this.deps.sshExec(this.opts.sshKeyPath, this.opts.ip, `chmod ${mode.toString(8)} ${shellEscape(path)}`);
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
    await this.deps.sshExec(this.opts.sshKeyPath, this.opts.ip, cmd);
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
