/**
 * Router URL injection for executors.
 *
 * When the LLM router is enabled, agent LLM calls should route through
 * Router -> TensorZero -> Provider. We achieve this by setting the
 * standard API base URL env vars (ANTHROPIC_BASE_URL, OPENAI_BASE_URL)
 * that the underlying CLI tools respect.
 */

import type { ArkConfig } from "../config.js";

export interface RouterEnvOpts {
  /** Which URL env vars to set: "claude" (Anthropic only) or "openai" (OpenAI + Anthropic for cross-compat) */
  mode: "claude" | "openai";
}

/**
 * Return a map of env vars that point LLM API calls at the router.
 * Returns an empty object if the router is not enabled.
 */
export function buildRouterEnv(config: ArkConfig, opts: RouterEnvOpts): Record<string, string> {
  if (!config.router?.enabled) return {};

  const routerUrl = config.router.url;
  const env: Record<string, string> = {};

  if (opts.mode === "claude") {
    env.ANTHROPIC_BASE_URL = routerUrl;
  } else {
    // openai mode: set both -- codex/aider/etc. use OPENAI_BASE_URL,
    // but some tools also respect ANTHROPIC_BASE_URL
    env.OPENAI_BASE_URL = `${routerUrl}/v1`;
    env.ANTHROPIC_BASE_URL = routerUrl;
  }

  return env;
}
