/**
 * EC2 placement context: medium-specific delivery of typed secrets to an
 * EC2 host over pure AWS SSM (no SSH).
 *
 * - writeFile: base64-encodes the file bytes and runs a single
 *   `mkdir -p ... && printf %s '<b64>' | base64 -d > <path> && chmod <mode>`
 *   command via SSM SendCommand. Replaces the legacy `tar c | ssh tar x`
 *   pipe -- AWS-RunShellScript can't accept arbitrary stdin, so we encode
 *   the bytes inline. Fine for typed secrets (<= a few MB); the size
 *   ceiling for SSM commands is ~64KB per parameter but bash here decodes
 *   inline so the practical ceiling is the bash command-line size limit
 *   (~128KB on Ubuntu 22). All current callers ship sub-1KB SSH keys.
 * - appendFile: idempotently replaces a marker-keyed block in a remote file
 *   via a sed BEGIN/END deletion + base64 stream-append.
 * - setEnv / getEnv: accumulates env vars for the agent launcher.
 * - setProvisionerConfig: no-op for EC2 (no kubeconfig consumed).
 * - expandHome: rewrites "~/foo" to "/home/ubuntu/foo".
 *
 * Placers (in core/secrets/placers/*) consume this exclusively via the
 * PlacementCtx interface and never see ssm, base64, or sed directly.
 */

import { ssmExec as defaultSsmExec } from "./ssm.js";
import { shellEscape } from "./shell-escape.js";
import { REMOTE_HOME } from "./constants.js";
import type { PlacementCtx } from "../../../secrets/placement-types.js";
import { logDebug } from "../../../observability/structured-log.js";

export interface EC2PlacementCtxOpts {
  instanceId: string;
  region: string;
  awsProfile?: string;
}

/**
 * Injection seam for tests. The default `ssmExec` here returns
 * `Promise<string>` (stdout) -- it wraps the real `ssmExec` from ssm.ts
 * which returns `{ stdout, stderr, exitCode }`. Production placers don't
 * consume the result.
 */
export interface EC2PlacementCtxDeps {
  ssmExec: (instanceId: string, cmd: string) => Promise<string>;
}

const defaultDeps = (opts: EC2PlacementCtxOpts): EC2PlacementCtxDeps => ({
  ssmExec: async (instanceId, cmd) => {
    const { stdout } = await defaultSsmExec({
      instanceId,
      region: opts.region,
      awsProfile: opts.awsProfile,
      command: cmd,
      timeoutMs: 60_000,
    });
    return stdout;
  },
});

/**
 * Test-only factory: build an EC2PlacementCtx with injected deps so tests
 * can stub ssmExec. Production callers should use the EC2PlacementCtx
 * constructor directly.
 */
export function _makeEC2PlacementCtx(opts: EC2PlacementCtxOpts & Partial<EC2PlacementCtxDeps>): EC2PlacementCtx {
  const baseOpts: EC2PlacementCtxOpts = {
    instanceId: opts.instanceId,
    region: opts.region,
    awsProfile: opts.awsProfile,
  };
  const deps: EC2PlacementCtxDeps = {
    ...defaultDeps(baseOpts),
    ...(opts.ssmExec ? { ssmExec: opts.ssmExec } : {}),
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
    // Encode the bytes inline as base64 and decode them on the remote.
    // Avoids the legacy `tar c | ssh tar x` pipe which can't be expressed
    // via SSM SendCommand (no stdin). Splitting fits within the bash
    // ARG_MAX even for hefty (few-MB) typed secrets.
    const encoded = Buffer.from(bytes).toString("base64");
    const dirIdx = path.lastIndexOf("/");
    const dir = dirIdx >= 0 ? path.slice(0, dirIdx) || "/" : ".";
    const cmd = [
      `mkdir -p ${shellEscape(dir)}`,
      `printf %s ${shellEscape(encoded)} | base64 -d > ${shellEscape(path)}`,
      `chmod ${mode.toString(8)} ${shellEscape(path)}`,
    ].join(" && ");
    await this.deps.ssmExec(this.opts.instanceId, cmd);
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
    const dirIdx = path.lastIndexOf("/");
    const dir = dirIdx >= 0 ? path.slice(0, dirIdx) || "/" : ".";
    const encoded = Buffer.from(bytes).toString("base64");
    const cmd = [
      `mkdir -p ${shellEscape(dir)}`,
      `touch ${shellEscape(path)}`,
      `sed -i '/${begin}/,/${end}/d' ${shellEscape(path)}`,
      `printf %s ${shellEscape(encoded)} | base64 -d >> ${shellEscape(path)}`,
    ].join(" && ");
    await this.deps.ssmExec(this.opts.instanceId, cmd);
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
