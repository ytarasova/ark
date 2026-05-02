/**
 * Shared helper for `Compute.prepareWorkspace`.
 *
 * Every Compute kind whose worktree lives away from the conductor's
 * filesystem (EC2, k8s, firecracker, kata) needs the same two arkd ops to
 * set up a per-session worktree: mkdir the parent, then git clone into the
 * leaf. Factor the body here so a future change (idempotency probe,
 * shallow-clone flags, alternative git transport) lands in one place.
 *
 * The legacy path lives in `RemoteWorktreeProvider.launch`
 * (`packages/compute/providers/remote-arkd.ts`); the call shape mirrored
 * here is identical -- same argv, same timeouts, same parent-directory
 * derivation. Task 7 of the dispatch-flip plan retires that path; until
 * then both run side-by-side.
 */

import { ArkdClient } from "../../arkd/client.js";

export interface RemoteCloneOpts {
  /** Conductor-reachable arkd URL for the target compute (`getArkdUrl(handle)`). */
  arkdUrl: string;
  /** Optional bearer token for arkd. Pass `process.env.ARK_ARKD_TOKEN ?? null`. */
  arkdToken: string | null;
  /** Source URL or path the remote `git clone` will pull from. */
  source: string;
  /** Absolute path on the compute the worktree should live at. */
  remoteWorkdir: string;
}

/**
 * `mkdir -p <parent>` + `git clone <source> <remoteWorkdir>` via arkd
 * HTTP. Used by every Compute kind whose worktree lives away from the
 * conductor's filesystem.
 *
 * Idempotency: the dispatcher's `Compute.resolveWorkdir` embeds the
 * session id into the path (`Projects/<sid>/<repo>`), so the leaf is
 * fresh per dispatch. The mkdir is also idempotent. We don't probe
 * "is this already cloned?" because the path is fresh; if a future
 * impl re-uses the path across dispatches, add a `git status` probe
 * here.
 *
 * Timeouts mirror the legacy `RemoteWorktreeProvider.launch` body
 * verbatim: 15s for mkdir, 120s for clone. Bumping clone past 120s
 * has historically masked broken-network sessions; lowering it
 * regresses sessions cloning large repos over slow links.
 */
export async function cloneWorkspaceViaArkd(opts: RemoteCloneOpts): Promise<void> {
  const client = new ArkdClient(opts.arkdUrl, opts.arkdToken ? { token: opts.arkdToken } : undefined);
  const parent = opts.remoteWorkdir.replace(/\/[^/]+$/, "");
  await client.run({ command: "mkdir", args: ["-p", parent], timeout: 15_000 });
  await client.run({ command: "git", args: ["clone", opts.source, opts.remoteWorkdir], timeout: 120_000 });
}
