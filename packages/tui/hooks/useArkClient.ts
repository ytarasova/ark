/**
 * Hook to access the ArkClient from React context.
 *
 * Every component that needs to talk to core uses this hook
 * instead of importing core/* directly.
 */

import { createContext, useContext } from "react";
import type { ArkClient } from "../../protocol/client.js";

export const ArkClientContext = createContext<ArkClient | null>(null);

export function useArkClient(): ArkClient {
  const client = useContext(ArkClientContext);
  if (!client) throw new Error("useArkClient must be used within ArkClientProvider");
  return client;
}
