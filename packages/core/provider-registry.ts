/**
 * Provider resolver registry -- breaks the circular import between app.ts and session-orchestration.ts.
 *
 * AppContext.boot() calls setProviderResolver() to register a resolver.
 * session-orchestration.ts calls resolveProvider() to look up providers for sessions.
 * Neither file needs to import the other for this plumbing.
 */

import type { ComputeProvider } from "../compute/types.js";
import type { Session, Compute } from "../types/index.js";

// App-level provider resolver -- set by AppContext.boot() via setProviderResolver()
export type ProviderResolver = (session: Session) => { provider: ComputeProvider | null; compute: Compute | null };
let _providerResolver: ProviderResolver | null = null;

/** Called by AppContext to register the provider resolver. */
export function setProviderResolver(resolver: ProviderResolver): void {
  _providerResolver = resolver;
}

/** Called by AppContext shutdown to clear the resolver. */
export function clearProviderResolver(): void {
  _providerResolver = null;
}

/**
 * Resolve the compute provider for a session.
 * Uses the AppContext-registered resolver. Returns null if not yet booted.
 */
export function resolveProvider(session: Session): { provider: ComputeProvider | null; compute: Compute | null } {
  if (!_providerResolver) return { provider: null, compute: null };
  return _providerResolver(session);
}
