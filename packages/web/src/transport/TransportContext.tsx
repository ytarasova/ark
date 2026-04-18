import React, { createContext, useContext, useEffect } from "react";
import type { WebTransport } from "./types.js";
import { HttpTransport } from "./HttpTransport.js";
import { setTransport } from "../hooks/useApi.js";

/**
 * Default transport -- plain HTTP to the same origin. Electron uses this too
 * because the desktop shell loads the SPA over `http://localhost:${port}`.
 */
const defaultTransport: WebTransport = new HttpTransport();

const TransportContext = createContext<WebTransport>(defaultTransport);

/** Hook for components that want direct access to the transport. */
export function useTransport(): WebTransport {
  return useContext(TransportContext);
}

/**
 * TransportProvider wraps the tree and also updates the module-level transport
 * used by the `api.*` call surface in `useApi.ts`. The setter pattern avoids
 * touching all 26 `api.*` call sites just to adopt the interface.
 */
export function TransportProvider({ transport, children }: { transport?: WebTransport; children: React.ReactNode }) {
  const resolved = transport ?? defaultTransport;

  // Sync the module-level transport so `api.*` calls route through the
  // currently-provided transport (important for tests that inject MockTransport).
  // useEffect fires on first mount + whenever `resolved` changes.
  useEffect(() => {
    setTransport(resolved);
  }, [resolved]);

  // Also set synchronously so that the first render's effects see the right transport.
  setTransport(resolved);

  return <TransportContext.Provider value={resolved}>{children}</TransportContext.Provider>;
}

export { defaultTransport };
