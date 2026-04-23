import React, { createContext, useContext } from "react";
import type { WebTransport } from "./types.js";
import { HttpTransport } from "./HttpTransport.js";

/**
 * Default transport -- plain HTTP to the same origin. Electron uses this too
 * because the desktop shell loads the SPA over `http://localhost:${port}`.
 *
 * This single instance is only used when a component reads the context
 * without a surrounding `<TransportProvider>`. The app's production root
 * always wraps in `<TransportProvider transport={new HttpTransport()}>`.
 */
const defaultTransport: WebTransport = new HttpTransport();

const TransportContext = createContext<WebTransport>(defaultTransport);

/**
 * Hook for components / hooks that need the transport directly (mostly SSE
 * subscribers and terminal sockets). Most call sites should prefer `useApi()`
 * from `hooks/useApi.ts`, which wraps `useTransport()` and returns a typed
 * client surface.
 */
export function useTransport(): WebTransport {
  return useContext(TransportContext);
}

/**
 * Pure-context transport provider. No side effects -- every `useTransport()`
 * call reads directly from React context, so two sibling providers with
 * different transports (e.g. in tests) stay fully isolated.
 */
export function TransportProvider({ transport, children }: { transport?: WebTransport; children: React.ReactNode }) {
  const resolved = transport ?? defaultTransport;
  return <TransportContext.Provider value={resolved}>{children}</TransportContext.Provider>;
}

export { defaultTransport };
