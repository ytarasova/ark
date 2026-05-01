/**
 * Executor launch + launch-env assembly.
 *
 * Two collaborators:
 *   - buildLaunchEnv: resolve stage+runtime secrets, merge tenant claude-auth,
 *                     and run typed-secret placement (Phase 1: additive, only
 *                     fires when the provider implements buildPlacementCtx).
 *   - launchAgent:   invoke executor.launch() with a fully-assembled option
 *                    object. Common to main dispatch and inline sub-stages.
 *
 * Both are pure-ish helpers; side-effects are limited to logging and the
 * executor's own launch behaviour.
 */

import type { DispatchDeps } from "./types.js";
import type { AgentDefinition } from "../../agent/agent.js";
import type { Session } from "../../../types/index.js";
import type { StageDefinition } from "../../state/flow.js";
import type { StageSecretResolver } from "./secrets-resolve.js";
import type { Executor, LaunchResult } from "../../executor.js";
import type { PlacementCtx } from "../../secrets/placement-types.js";
import { providerOf } from "../../../compute/adapters/provider-map.js";
import { placeAllSecrets } from "../../secrets/placement.js";
import { logDebug, logWarn } from "../../observability/structured-log.js";

export interface LaunchEnvResult {
  env: Record<string, string>;
  error?: string;
  /**
   * The PlacementCtx used during pre-launch placement, when the provider
   * implements `buildPlacementCtx`. For SSH-medium providers this is a
   * `DeferredPlacementCtx` whose queued file ops the provider replays
   * post-provision via `flushDeferredPlacement`. For providers that can
   * place pre-launch (k8s) it's the real ctx that already executed the
   * file ops -- there is nothing to flush, but plumbing it through is
   * harmless. Undefined when the provider has no buildPlacementCtx, or
   * the session has no resolved compute.
   */
  placement?: PlacementCtx;
}

/**
 * Build the merged env we hand to executor.launch(). Order:
 *   1. Stage + runtime secrets (first wins on name collision; stage beats runtime).
 *   2. Tenant-level claude auth (wins over secrets -- operators who set
 *      ANTHROPIC_API_KEY on the tenant expect it to be authoritative).
 *   3. Typed-secret placement (Phase 1: only runs when the provider implements
 *      `buildPlacementCtx`). Merges any env vars the placers set into the
 *      launch env. The legacy paths above stay -- placement is *additive* in
 *      Phase 1; Phase 3 will retire the redundant paths.
 *
 * A missing secret surfaces as `error`; callers fail dispatch. Claude auth
 * materialization may also emit a k8s Secret side-effect (credsSecretName).
 */
export async function buildLaunchEnv(
  deps: Pick<DispatchDeps, "computes" | "materializeClaudeAuth" | "runtimes" | "getApp">,
  secrets: StageSecretResolver,
  session: Session,
  stageDef: StageDefinition | null,
  runtime: string,
  log: (msg: string) => void,
): Promise<LaunchEnvResult> {
  // Resolve secrets declared on the stage + the runtime and merge them
  // into the launch env. Stage secrets win over runtime secrets on name
  // conflict. A missing secret fails dispatch with a clear message --
  // we never silently drop an env var the agent depends on.
  const secretEnv = await secrets.resolve(session, stageDef, runtime, log);
  if (secretEnv.error) return { env: {}, error: secretEnv.error };

  // Tenant-level claude auth materialization. Runs BEFORE we read the
  // compute row for launch so any `credsSecretName` mutation lands before
  // the provider sees it.
  const computeForAuth = session.compute_name ? await deps.computes.get(session.compute_name) : null;
  const claudeAuth = await deps.materializeClaudeAuth(session, computeForAuth);
  if (Object.keys(claudeAuth.env).length > 0) {
    log(`Injected tenant-level claude auth env: ${Object.keys(claudeAuth.env).join(", ")}`);
  }
  if (claudeAuth.credsSecretName) {
    log(`Materialized subscription blob as k8s Secret '${claudeAuth.credsSecretName}'`);
  }

  const env: Record<string, string> = { ...secretEnv.env, ...claudeAuth.env };
  let placement: PlacementCtx | undefined;

  // Typed-secret placement (Phase 1: additive, gated on provider opt-in).
  //
  // The narrowing filter is the union of stage-declared and runtime-declared
  // secret names. Empty means "auto-attach all tenant secrets". This mirrors
  // how the legacy `secrets.resolve()` path scopes things, so a session that
  // declared no secrets stays narrow even when placement runs.
  //
  // Until a provider opts in via `buildPlacementCtx`, this branch is dead --
  // placeAllSecrets does not run, no env mutation. Tasks 18-20 wire up the
  // first real impl (EC2). The wiring lives here so those tasks can land
  // without touching dispatch again.
  if (computeForAuth) {
    try {
      const app = deps.getApp();
      const provider = app.getProvider(providerOf(computeForAuth));
      if (provider?.buildPlacementCtx) {
        const stageSecrets = stageDef?.secrets ?? [];
        let runtimeSecrets: string[] = [];
        try {
          const rt = deps.runtimes?.get?.(runtime);
          runtimeSecrets = Array.isArray(rt?.secrets) ? (rt as { secrets?: string[] }).secrets! : [];
        } catch (err: any) {
          // Runtime row may be absent in legacy/test paths -- the legacy
          // resolve() above already tolerates this; placement does too.
          // Pre-test fallback path; debug-level is appropriate here.
          logDebug("session", `runtimes.get('${runtime}') failed inside placement narrowing: ${err?.message ?? err}`);
        }
        const narrow: Set<string> | undefined =
          stageSecrets.length === 0 && runtimeSecrets.length === 0
            ? undefined
            : new Set([...stageSecrets, ...runtimeSecrets]);

        const ctx = await provider.buildPlacementCtx(session, computeForAuth);
        await placeAllSecrets(app, session, ctx, { narrow });
        Object.assign(env, ctx.getEnv());
        placement = ctx;
      }
    } catch (err: any) {
      // Placer errors for fail-fast types (env-var, ssh-private-key, kubeconfig)
      // surface here. Failing closed is right: missing one of these silently
      // breaks the agent in subtle ways. Phase 3 collapses the legacy path so
      // there is only one place that can fail; in Phase 1 we keep both.
      logWarn("session", `placeAllSecrets failed: ${err?.message ?? err}`);
      return { env: {}, error: `Secret placement failed: ${err?.message ?? String(err)}` };
    }
  }

  return { env, placement };
}

export interface LaunchAgentOpts {
  sessionId: string;
  session: Session;
  agent: AgentDefinition;
  task: string;
  claudeArgs: string[];
  env: Record<string, string>;
  stage: string;
  autonomy: string;
  log: (msg: string) => void;
  prevClaudeSessionId?: string | null;
  sessionName: string;
  initialPrompt: string;
  /**
   * PlacementCtx produced by `buildLaunchEnv`. Forwarded through the
   * executor onto provider.launch so SSH-medium providers can flush
   * queued file ops post-provision. Optional -- absent when the provider
   * doesn't implement `buildPlacementCtx`, or there's no resolved compute.
   */
  placement?: PlacementCtx;
}

/**
 * Invoke the executor. Resolves the per-session compute row from session.compute_name
 * and passes it through (executors read provider-specific config off it).
 *
 * Returns the executor's LaunchResult directly.
 */
export async function launchAgent(
  deps: Pick<DispatchDeps, "computes" | "getApp">,
  executor: Executor,
  opts: LaunchAgentOpts,
): Promise<LaunchResult> {
  const compute = opts.session.compute_name
    ? (((await deps.computes.get(opts.session.compute_name)) as unknown as {
        name: string;
        provider: string;
        [k: string]: unknown;
      } | null) ?? undefined)
    : undefined;

  return executor.launch({
    sessionId: opts.sessionId,
    workdir: opts.session.workdir ?? opts.session.repo,
    agent: opts.agent as any,
    task: opts.task,
    claudeArgs: opts.claudeArgs,
    env: opts.env,
    stage: opts.stage,
    autonomy: opts.autonomy,
    onLog: opts.log,
    prevClaudeSessionId: opts.prevClaudeSessionId ?? undefined,
    sessionName: opts.sessionName,
    initialPrompt: opts.initialPrompt,
    compute,
    placement: opts.placement,
    // LaunchOpts.app is still required by the executor interface; dispatch
    // is the sole reader of getApp() in this class. Refactoring executors
    // off AppContext is a separate migration.
    app: deps.getApp(),
  });
}
