/**
 * Provider-agnostic remote-environment preparation for the claude-code
 * executor.
 *
 * This module owns the dispatch-time orchestration that's shared across
 * every compute provider:
 *
 *   1. Auto-start a stopped compute (delegated to provider.start).
 *   2. Run the provider's transport setup (`provider.prepareForLaunch`),
 *      which knows its own medium-specific steps -- SSH-over-SSM for
 *      EC2, kubectl port-forward for k8s, no-op for local. Each provider
 *      is responsible for emitting `provisioning_step` events for its
 *      own internal phases.
 *   3. Resolve `arc.json`-declared ports.
 *   4. Apply opt-in container setup (Docker Compose / devcontainer).
 *
 * Things this module deliberately does NOT do:
 *   - Touch SSH, AWS SSM, EC2 metadata, or any other provider-specific
 *     transport concept. The provider owns its medium.
 *   - Run the agent. That's `provider.launch(...)` (today, will move to
 *     a provider-agnostic arkd orchestrator in a follow-up).
 *
 * The only thing this module knows about a provider is the optional
 * `prepareForLaunch` hook -- everything else is a black box.
 */

import type { AppContext } from "../app.js";
import type { Session, Compute } from "../../types/index.js";
import type { ComputeProvider } from "../../compute/types.js";
import { resolvePortDecls, parseArcJson } from "../../compute/arc-json.js";
import { provisionStep } from "./provisioning-steps.js";

/**
 * Apply opt-in container setup declared in `arc.json`:
 *   - `compose: true`        -> `docker compose up -d` on the remote
 *   - `devcontainer: true`   -> wrap launch content in the devcontainer launcher
 *
 * Most sessions have neither; the function is a fast no-op on bare
 * worktrees, so we don't wrap it in a `provisionStep` -- the trace
 * would be noise for the 99% case.
 *
 * This is the only piece of provider-specific knowledge left in this
 * module: it pokes EC2's `sshExec` / `shellEscape` when `compose: true`
 * because there's no clean provider-side hook for "run an arbitrary
 * command on the host as part of pre-launch". A follow-up should move
 * this onto a `provider.runOnHost(cmd)` hook so this module is fully
 * provider-agnostic.
 */
async function applyContainerSetup(
  compute: Compute,
  effectiveWorkdir: string,
  launchContent: string,
  onLog: (msg: string) => void,
): Promise<string> {
  if (!effectiveWorkdir) return launchContent;

  const arcJson = parseArcJson(effectiveWorkdir);
  const cfg = compute.config as { instance_id?: string; region?: string; aws_profile?: string } | null | undefined;

  if (arcJson?.compose === true && cfg?.instance_id) {
    onLog("Starting Docker Compose services...");
    const { sshExec, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");
    const { shellEscape } = await import("../../compute/providers/ec2/shell-escape.js");
    // `effectiveWorkdir` is DB-persisted (transitively from
    // session.workdir / session.repo, both attacker-controllable in
    // hosted mode). Escape before interpolating into the remote shell.
    const quotedWorkdir = shellEscape(effectiveWorkdir);
    sshExec(sshKeyPath(compute.name), cfg.instance_id, `cd ${quotedWorkdir} && docker compose up -d`, {
      region: cfg.region ?? "us-east-1",
      awsProfile: cfg.aws_profile,
    });
  }

  if (arcJson?.devcontainer === true) {
    onLog("Building devcontainer...");
    const { buildLaunchCommand } = await import("../../compute/providers/docker/devcontainer.js");
    return buildLaunchCommand(effectiveWorkdir, launchContent);
  }

  return launchContent;
}

/**
 * Bring a compute target to the point where the agent can be launched.
 * Returns the (possibly container-wrapped) launch script and the
 * declared ports from `arc.json`.
 */
export async function prepareRemoteEnvironment(
  app: AppContext,
  session: Session,
  compute: Compute,
  provider: ComputeProvider,
  effectiveWorkdir: string,
  opts?: { launchContent?: string; onLog?: (msg: string) => void },
): Promise<{ finalLaunchContent: string; ports: ReturnType<typeof resolvePortDecls> }> {
  const log = opts?.onLog ?? (() => {});
  const sid = session.id;

  // Auto-start a stopped compute. Wrapped as a step so the timeline
  // shows a uniform entry instead of an opaque pause.
  if (compute.status === "stopped") {
    log(`Starting compute '${compute.name}'...`);
    await provisionStep(app, sid, "compute-start", () => provider.start(compute), {
      retries: 1,
      retryBackoffMs: 2_000,
      context: { compute: compute.name },
    });
  }

  // Hand off to the provider for medium-specific transport setup.
  // Local providers don't implement this hook -- arkd is on the same
  // host and there's nothing to do.
  if (provider.prepareForLaunch) {
    await provider.prepareForLaunch({ app, compute, session, onLog: log });
  }

  // Resolve declared ports + persist on session config so the launcher
  // can plumb them through to the agent runtime.
  const ports = effectiveWorkdir ? resolvePortDecls(effectiveWorkdir) : [];
  if (ports.length > 0) {
    await app.sessions.update(session.id, { config: { ...session.config, ports } });
  }

  const finalLaunchContent = await applyContainerSetup(compute, effectiveWorkdir, opts?.launchContent ?? "", log);
  return { finalLaunchContent, ports };
}
