/**
 * Executor launch + launch-env assembly.
 *
 * Two collaborators:
 *   - buildLaunchEnv: resolve stage+runtime secrets, merge tenant claude-auth.
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

export interface LaunchEnvResult {
  env: Record<string, string>;
  error?: string;
}

/**
 * Build the merged env we hand to executor.launch(). Order:
 *   1. Stage + runtime secrets (first wins on name collision; stage beats runtime).
 *   2. Tenant-level claude auth (wins over secrets -- operators who set
 *      ANTHROPIC_API_KEY on the tenant expect it to be authoritative).
 *
 * A missing secret surfaces as `error`; callers fail dispatch. Claude auth
 * materialization may also emit a k8s Secret side-effect (credsSecretName).
 */
export async function buildLaunchEnv(
  deps: Pick<DispatchDeps, "computes" | "materializeClaudeAuth">,
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

  return { env: { ...secretEnv.env, ...claudeAuth.env } };
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
    // LaunchOpts.app is still required by the executor interface; dispatch
    // is the sole reader of getApp() in this class. Refactoring executors
    // off AppContext is a separate migration.
    app: deps.getApp(),
  });
}
