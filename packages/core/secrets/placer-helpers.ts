import { execFile } from "child_process";
import { promisify } from "util";
import { logWarn } from "../observability/structured-log.js";

const execFileAsync = promisify(execFile);

export interface RunKeyScanOpts {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.ARK_KEYSCAN_TIMEOUT_MS ?? 5000);

/**
 * Runs `ssh-keyscan -T <secs> <host...>` on the control plane. Returns the
 * stdout bytes verbatim (suitable for appending to ~/.ssh/known_hosts).
 * Returns an empty buffer on timeout / failure -- the placer logs and
 * proceeds; the session will fail loudly at the first git op rather than
 * hanging dispatch.
 */
export async function runKeyScan(hosts: string[], opts: RunKeyScanOpts = {}): Promise<Uint8Array> {
  const deduped = Array.from(new Set(hosts));
  if (deduped.length === 0) return new Uint8Array();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tSecs = Math.max(1, Math.floor(timeoutMs / 1000));
  try {
    const { stdout } = await execFileAsync("ssh-keyscan", ["-T", String(tSecs), ...deduped], {
      encoding: "buffer",
      timeout: timeoutMs,
    });
    return new Uint8Array(stdout);
  } catch (e: any) {
    logWarn("general", `ssh-keyscan failed for ${deduped.join(",")}: ${e?.message ?? e}`);
    return new Uint8Array();
  }
}

export interface SshConfigBlockOpts {
  name: string;
  host: string;
  aliases?: string[];
  keyPath: string;
  username: string;
}

export function buildSshConfigBlock(opts: SshConfigBlockOpts): string {
  const hostLine = [opts.host, ...(opts.aliases ?? [])].join(" ");
  return [
    `# BEGIN ark:secret:${opts.name}`,
    `Host ${hostLine}`,
    `  IdentityFile ${opts.keyPath}`,
    `  IdentitiesOnly yes`,
    `  User ${opts.username}`,
    // accept-new: trust-on-first-use for the host key. The control-plane
    // ssh-keyscan can fail (network blip, host slow to respond, behind a
    // firewall) and we don't want git/ssh to choke on an empty known_hosts.
    // accept-new accepts an unseen key on first connect and writes it,
    // then enforces it on subsequent connects -- safer than `no` (which
    // also disables MITM detection).
    `  StrictHostKeyChecking accept-new`,
    `# END ark:secret:${opts.name}`,
    "",
  ].join("\n");
}

export function validateMetadataPath(path: string): void {
  if (path.includes("\0")) throw new Error(`metadata path contains NUL byte`);
  if (/[\r\n]/.test(path)) throw new Error(`metadata path contains control character`);
  if (path.includes("..")) throw new Error(`metadata path traversal: ${path}`);
  if (path.startsWith("/") && !path.startsWith("/run/secrets/")) {
    throw new Error(`metadata path absolute and outside ~/. or /run/secrets/: ${path}`);
  }
  if (!path.startsWith("~/") && !path.startsWith("/run/secrets/")) {
    throw new Error(`metadata path must start with ~/ or /run/secrets/: ${path}`);
  }
}
