/**
 * Router URL injection for executors.
 *
 * When the LLM router is enabled, agent LLM calls should route through
 * ArkD -> Conductor -> Router -> TensorZero -> Provider. We achieve this
 * by setting the standard API base URL env vars (ANTHROPIC_BASE_URL,
 * OPENAI_BASE_URL) to point at the local arkd instance which is
 * guaranteed to be co-located on every compute target.
 */

import type { ArkConfig } from "../config.js";
import { DEFAULT_ARKD_PORT } from "../constants.js";

export interface RouterEnvOpts {
  /** Which URL env vars to set: "claude" (Anthropic only) or "openai" (OpenAI + Anthropic for cross-compat) */
  mode: "claude" | "openai";
}

/**
 * Return a map of env vars that point LLM API calls at arkd's proxy.
 * Returns an empty object if the router is not enabled.
 *
 * Agents always talk to their local arkd (:19300), which forwards to
 * the conductor, which forwards to the router. This works for both
 * local and remote (EC2, k8s, Firecracker) compute targets.
 */
export function buildRouterEnv(config: ArkConfig, opts: RouterEnvOpts): Record<string, string> {
  if (!config.router?.enabled) return {};

  const arkdUrl = `http://localhost:${DEFAULT_ARKD_PORT}`;
  const env: Record<string, string> = {};

  if (opts.mode === "claude") {
    env.ANTHROPIC_BASE_URL = arkdUrl;
  } else {
    // openai mode: set both -- codex and similar tools use OPENAI_BASE_URL,
    // but some tools also respect ANTHROPIC_BASE_URL
    env.OPENAI_BASE_URL = `${arkdUrl}/v1`;
    env.ANTHROPIC_BASE_URL = arkdUrl;
  }

  return env;
}
