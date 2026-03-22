/**
 * Clipboard sync for EC2 sessions.
 * Watches the macOS clipboard for images and uploads them to a remote
 * session's working directory via rsync.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { rsyncPush } from "./ssh.js";

const CLIPBOARD_TMP = "/tmp/ark-clipboard.png";

/**
 * Check if macOS clipboard has image content using osascript.
 * If yes, save to a temp file and return the path.
 * If no, return null.
 */
export function getClipboardImage(): string | null {
  try {
    const info = execFileSync("osascript", ["-e", "clipboard info"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const hasImage =
      info.includes("«class PNGf»") || info.includes("public.png");
    if (!hasImage) return null;

    execFileSync(
      "osascript",
      [
        "-e",
        'set png to (the clipboard as «class PNGf»)\nset f to open for access (POSIX file "/tmp/ark-clipboard.png") with write permission\nwrite png to f\nclose access f',
      ],
      {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    return CLIPBOARD_TMP;
  } catch {
    return null;
  }
}

/**
 * Upload an image file to the remote session's working directory via rsync.
 */
export function uploadToSession(
  key: string,
  ip: string,
  localPath: string,
  remoteWorkdir: string,
): void {
  rsyncPush(key, ip, localPath, remoteWorkdir);
}

/**
 * Start polling the macOS clipboard for image content on an interval.
 * Tracks file content hashes to avoid re-uploading the same image.
 * Returns a handle with stop() to cancel the watcher.
 */
export function watchClipboard(
  key: string,
  ip: string,
  remoteWorkdir: string,
  opts?: {
    intervalMs?: number;
    onUpload?: (filename: string) => void;
  },
): { stop: () => void } {
  const intervalMs = opts?.intervalMs ?? 5000;
  let lastHash: string | null = null;

  const timer = setInterval(() => {
    const imgPath = getClipboardImage();
    if (!imgPath) return;

    try {
      const content = readFileSync(imgPath);
      const hash = createHash("sha256").update(content).digest("hex");

      if (hash === lastHash) return;
      lastHash = hash;

      const filename = `clipboard-${Date.now()}.png`;
      const remoteDest = remoteWorkdir.endsWith("/")
        ? `${remoteWorkdir}${filename}`
        : `${remoteWorkdir}/${filename}`;

      uploadToSession(key, ip, imgPath, remoteDest);
      opts?.onUpload?.(filename);
    } catch {
      // best-effort — skip this tick
    }
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
