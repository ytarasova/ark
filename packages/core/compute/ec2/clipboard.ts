/**
 * Clipboard sync for EC2 sessions.
 * Watches the macOS clipboard for images and uploads them to a remote
 * session's working directory via SSM SendCommand (base64-encoded).
 *
 * Replaces the legacy rsync-over-SSM-SSH path; with pure SSM there's no
 * stdin pipe available, so we encode the image bytes inline. Practical
 * upper bound is ~64KB of raw bytes per SSM SendCommand parameter, so
 * larger pasted screenshots may need a fallback to S3 in the future.
 * Today's clipboard images comfortably fit -- a typical PNG screenshot
 * compresses to 100-300KB which becomes ~130-400KB base64.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { ssmExec, type SsmConnectOpts } from "./ssm.js";
import { shellEscape } from "./shell-escape.js";
import { logDebug } from "../../observability/structured-log.js";

const execFileAsync = promisify(execFile);

const CLIPBOARD_TMP = "/tmp/ark-clipboard.png";

/**
 * Check if macOS clipboard has image content using osascript.
 * If yes, save to a temp file and return the path.
 * If no, return null.
 */
export async function getClipboardImage(): Promise<string | null> {
  try {
    const { stdout: info } = await execFileAsync("osascript", ["-e", "clipboard info"], {
      encoding: "utf-8",
      timeout: 5_000,
    });

    const hasImage = info.includes("«class PNGf»") || info.includes("public.png");
    if (!hasImage) return null;

    await execFileAsync(
      "osascript",
      [
        "-e",
        'set png to (the clipboard as «class PNGf»)\nset f to open for access (POSIX file "/tmp/ark-clipboard.png") with write permission\nwrite png to f\nclose access f',
      ],
      {
        encoding: "utf-8",
        timeout: 5_000,
      },
    );

    return CLIPBOARD_TMP;
  } catch {
    return null;
  }
}

/**
 * Upload an image file to the remote session's working directory by
 * base64-encoding it and shipping it through SSM SendCommand.
 */
export async function uploadToSession(
  instanceId: string,
  localPath: string,
  remotePath: string,
  ssm: SsmConnectOpts,
): Promise<void> {
  const bytes = readFileSync(localPath);
  const encoded = bytes.toString("base64");
  const dirIdx = remotePath.lastIndexOf("/");
  const dir = dirIdx >= 0 ? remotePath.slice(0, dirIdx) || "/" : ".";
  const cmd = [
    `mkdir -p ${shellEscape(dir)}`,
    `printf %s ${shellEscape(encoded)} | base64 -d > ${shellEscape(remotePath)}`,
  ].join(" && ");
  await ssmExec({
    instanceId,
    region: ssm.region,
    awsProfile: ssm.awsProfile,
    command: cmd,
    timeoutMs: 60_000,
  });
}

/**
 * Start polling the macOS clipboard for image content on an interval.
 * Tracks file content hashes to avoid re-uploading the same image.
 * Returns a handle with stop() to cancel the watcher.
 */
export function watchClipboard(
  instanceId: string,
  remoteWorkdir: string,
  ssm: SsmConnectOpts,
  opts?: {
    intervalMs?: number;
    onUpload?: (filename: string) => void;
  },
): { stop: () => void } {
  const intervalMs = opts?.intervalMs ?? 5000;
  let lastHash: string | null = null;

  const timer = setInterval(async () => {
    const imgPath = await getClipboardImage();
    if (!imgPath) return;

    try {
      const content = readFileSync(imgPath);
      const hash = createHash("sha256").update(content).digest("hex");

      if (hash === lastHash) return;
      lastHash = hash;

      const filename = `clipboard-${Date.now()}.png`;
      const remoteDest = remoteWorkdir.endsWith("/") ? `${remoteWorkdir}${filename}` : `${remoteWorkdir}/${filename}`;

      await uploadToSession(instanceId, imgPath, remoteDest, ssm);
      opts?.onUpload?.(filename);
    } catch {
      logDebug("compute", "best-effort - skip this tick");
    }
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
