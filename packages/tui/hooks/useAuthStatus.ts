/**
 * Computes whether Claude auth credentials are available for remote compute.
 * Uses useMemo to avoid blocking the render loop -- all I/O is sync-safe
 * (env var reads + single small file check).
 */

import { useMemo } from "react";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Compute } from "../../core/index.js";
import { getProvider } from "../../compute/index.js";

interface AuthStatus {
  hasAuth: boolean;
  authType: string | null;
}

export function useAuthStatus(compute: Compute | undefined | null): AuthStatus {
  return useMemo(() => {
    if (!compute) return { hasAuth: true, authType: null };

    const provider = getProvider(compute.provider);
    if (!provider?.needsAuth) return { hasAuth: true, authType: null };

    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { hasAuth: true, authType: "oauth_env" };
    }
    if (process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN) {
      return { hasAuth: true, authType: "session_env" };
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return { hasAuth: true, authType: "api_key_env" };
    }

    // Check saved token from 'ark auth'
    const tokenFile = join(process.env.HOME!, ".ark", "claude-oauth-token");
    if (existsSync(tokenFile)) {
      try {
        const token = readFileSync(tokenFile, "utf-8").trim();
        if (token) {
          // Set env so downstream code (dispatch) picks it up
          process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
          return { hasAuth: true, authType: "saved_token" };
        }
      } catch { /* token retrieval is optional */ }
    }

    return { hasAuth: false, authType: null };
  }, [compute?.name, compute?.provider]);
}
