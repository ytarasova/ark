/**
 * Shared Docker helpers used by the arkd-sidecar Docker provider.
 *
 * Covers image pull, container create/start/stop/remove, bootstrap
 * (install runtime deps inside the container), and start-arkd-in-container.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { join, dirname, resolve as pathResolve } from "path";
import { existsSync } from "fs";

const execFileAsync = promisify(execFile);

const DEFAULT_IMAGE = "ubuntu:22.04";
/** Port arkd binds to INSIDE the container. Mapped to a host-side ephemeral port. */
const ARKD_INTERNAL_PORT = 19300;

/** Bootstrap options. Idempotent; each tool check-and-installs only if missing. */
export interface BootstrapOpts {
  /** Install git if missing. Default true. */
  git?: boolean;
  /** Install Bun (required for arkd). Default true. */
  bun?: boolean;
  /** Install tmux (required for arkd launchAgent). Default true. */
  tmux?: boolean;
  /** Install Claude Code CLI (required if runtime=claude). Default true. */
  claude?: boolean;
  /** Skip bootstrap entirely (user image already has everything). Default false. */
  skip?: boolean;
}

/** Options for creating a container. */
export interface CreateContainerOpts {
  /** Extra host:container volume specs passed to `-v`. */
  extraVolumes?: string[];
  /** arkDir on host; mounted at the same path inside so launcher scripts resolve. */
  arkDir?: string;
  /** Session workdir; mounted at the same path so the launcher's `cd` works. */
  workdir?: string;
  /** Path to the ark repo root; mounted at /opt/ark so arkd can run inside. */
  arkSource?: string;
  /** Host port mapped to ARKD_INTERNAL_PORT inside the container. */
  arkdHostPort?: number;
}

/** Pull a Docker image. 5-min timeout for large images over slow networks. */
export async function pullImage(image: string): Promise<void> {
  await execFileAsync("docker", ["pull", image], { timeout: 300_000 });
}

/**
 * Create a persistent Docker container configured as an arkd sidecar target:
 *
 *   ~/.ssh           -> /root/.ssh      (ro)  -- git push over SSH
 *   ~/.claude        -> /root/.claude   (ro)  -- agent credentials
 *   ~/.aws           -> /root/.aws      (ro)  -- optional, only if present
 *   arkSource        -> /opt/ark        (ro)  -- ark repo, so we can bun-run arkd
 *   arkDir           -> arkDir                -- launcher + tracks + recordings
 *   workdir          -> workdir               -- same absolute path inside
 *
 * arkdHostPort maps to 19300 inside, which is where arkd binds after bootstrap.
 */
export async function createContainer(name: string, image: string, opts: CreateContainerOpts = {}): Promise<void> {
  const home = homedir();
  const { extraVolumes = [], arkDir, workdir, arkSource, arkdHostPort } = opts;

  const createArgs = [
    "create",
    "--name",
    name,
    "-it",
    "-v",
    `${join(home, ".ssh")}:/root/.ssh:ro`,
    "-v",
    `${join(home, ".claude")}:/root/.claude:ro`,
  ];

  const awsDir = join(home, ".aws");
  if (existsSync(awsDir)) {
    createArgs.push("-v", `${awsDir}:/root/.aws:ro`);
  }

  if (arkSource && existsSync(arkSource)) {
    // Read-only: arkd only needs to read source + node_modules. Writable
    // state lives in arkDir.
    createArgs.push("-v", `${arkSource}:/opt/ark:ro`);
  }

  if (arkDir && existsSync(arkDir)) {
    createArgs.push("-v", `${arkDir}:${arkDir}`);
  }

  if (workdir && existsSync(workdir)) {
    createArgs.push("-v", `${workdir}:${workdir}`);
  }

  for (const vol of extraVolumes) {
    createArgs.push("-v", vol);
  }

  if (typeof arkdHostPort === "number") {
    // Bind only to loopback on the host -- we never want arkd exposed to the
    // outside world. Even the host-to-container traffic stays on 127.0.0.1.
    createArgs.push("-p", `127.0.0.1:${arkdHostPort}:${ARKD_INTERNAL_PORT}`);
  }

  createArgs.push(image, "bash");
  await execFileAsync("docker", createArgs, { timeout: 30_000 });
}

/** Start an existing Docker container. */
export async function startContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["start", name], { timeout: 15_000 });
}

/** Stop a Docker container. */
export async function stopContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["stop", name], { timeout: 15_000 });
}

/** Remove a Docker container forcefully. */
export async function removeContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["rm", "-f", name], { timeout: 15_000 });
}

/**
 * Install the runtime tools arkd needs to serve requests and launch agents.
 *
 * Idempotent: each install is gated on a `command -v` probe so reruns against
 * an already-bootstrapped image are essentially free. Compatible with apt
 * (Debian/Ubuntu), apk (Alpine), dnf/yum (RHEL-family). bun + claude install
 * via their upstream curl-pipe-sh scripts and are pkg-manager-independent.
 */
export async function bootstrapContainer(name: string, opts: BootstrapOpts = {}): Promise<void> {
  if (opts.skip) return;

  const wantGit = opts.git !== false;
  const wantBun = opts.bun !== false;
  const wantTmux = opts.tmux !== false;
  const wantClaude = opts.claude !== false;

  const script = buildBootstrapScript({ wantGit, wantBun, wantTmux, wantClaude });

  await execFileAsync("docker", ["exec", "-i", name, "bash", "-c", script], {
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Build the bootstrap shell script used to install arkd's runtime deps
 * (tmux, git, bun, claude) inside an arbitrary container.
 *
 * Exported so non-default callers (`DevcontainerRuntime` compose branch) can
 * reuse the exact same script against a container they didn't create via
 * `createContainer`. The default `bootstrapContainer` entry point wraps this
 * + `docker exec -i`; callers that need a different exec surface (e.g. a
 * compose-managed container name, or a user other than root) can call this,
 * then shell out themselves.
 */
export function buildBootstrapScript(opts: {
  wantGit: boolean;
  wantBun: boolean;
  wantTmux: boolean;
  wantClaude: boolean;
}): string {
  return `
set -euo pipefail

pkgmgr=""
if command -v apt-get >/dev/null 2>&1; then pkgmgr=apt
elif command -v apk    >/dev/null 2>&1; then pkgmgr=apk
elif command -v dnf    >/dev/null 2>&1; then pkgmgr=dnf
elif command -v yum    >/dev/null 2>&1; then pkgmgr=yum
fi

apt_updated=0
apt_update_once() {
  if [ "$apt_updated" = "0" ] && [ "$pkgmgr" = "apt" ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -yq
    apt_updated=1
  fi
}

install_pkg() {
  local pkg="$1"
  case "$pkgmgr" in
    apt) apt_update_once; apt-get install -yq --no-install-recommends "$pkg" ;;
    apk) apk add --no-cache "$pkg" ;;
    dnf) dnf install -yq "$pkg" ;;
    yum) yum install -yq "$pkg" ;;
    *)   echo "warn: no supported package manager; cannot install $pkg" >&2 ;;
  esac
}

# curl + ca-certificates + unzip are pre-reqs for the curl-pipe-sh installers.
# Bun's installer shells out to unzip; without it the bun install silently
# aborts with "unzip is required to install bun".
command -v curl >/dev/null 2>&1 || install_pkg curl
[ -f /etc/ssl/certs/ca-certificates.crt ] || install_pkg ca-certificates
command -v unzip >/dev/null 2>&1 || install_pkg unzip

${opts.wantTmux ? "command -v tmux >/dev/null 2>&1 || install_pkg tmux" : ""}
${opts.wantGit ? "command -v git  >/dev/null 2>&1 || install_pkg git" : ""}

${
  opts.wantBun
    ? `
# Bun: upstream installer drops into ~/.bun. Symlink to /usr/local/bin so
# every shell (including arkd's spawned tmux subshells) finds it on PATH.
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash >/dev/null
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
`
    : ""
}

${
  opts.wantClaude
    ? `
# Claude Code CLI. Best-effort: if the installer fails we keep going -- the
# user may have baked claude into their own image or use a different runtime.
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || true
  if [ -x "$HOME/.local/bin/claude" ]; then
    ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude
  fi
fi
`
    : ""
}

echo "[bootstrap] tmux:   $(command -v tmux   || echo missing)"
echo "[bootstrap] git:    $(command -v git    || echo missing)"
echo "[bootstrap] bun:    $(command -v bun    || echo missing)"
echo "[bootstrap] claude: $(command -v claude || echo missing)"
`;
}

/**
 * Start arkd inside the container as a detached background process. Writes
 * stdout/stderr to /var/log/arkd.log so crashes are diagnosable after the fact.
 */
export async function startArkdInContainer(name: string, conductorUrl: string): Promise<void> {
  const cmd = [
    "sh",
    "-c",
    `nohup bun run /opt/ark/packages/cli/index.ts arkd ` +
      `--port ${ARKD_INTERNAL_PORT} --hostname 0.0.0.0 ` +
      `--conductor-url '${conductorUrl.replace(/'/g, "'\\''")}' ` +
      `> /var/log/arkd.log 2>&1 &`,
  ];
  await execFileAsync("docker", ["exec", "-d", name, ...cmd], { timeout: 15_000 });
}

/** Poll `${url}/snapshot` until 200 or deadline. Used after startArkdInContainer. */
export async function waitForArkdHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/snapshot`, { method: "GET" });
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`arkd did not become healthy at ${url} within ${timeoutMs}ms: ${String(lastErr)}`);
}

/**
 * Detect the ark repo root on the host so we can mount it as /opt/ark for
 * arkd-inside-the-container to `bun run`. Returns null when source is not
 * locatable (compiled-only install without shipped source tree).
 */
export function resolveArkSourceRoot(): string | null {
  try {
    const here = new URL(import.meta.url).pathname;
    const dockerDir = dirname(here);
    const providersDir = dirname(dockerDir);
    const computeDir = dirname(providersDir);
    const packagesDir = dirname(computeDir);
    const root = dirname(packagesDir);
    if (existsSync(join(root, "packages", "cli", "index.ts"))) {
      return pathResolve(root);
    }
  } catch {
    /* fall through */
  }
  return null;
}

export { DEFAULT_IMAGE, ARKD_INTERNAL_PORT };
