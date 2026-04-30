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
