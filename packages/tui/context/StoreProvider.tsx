/**
 * React Context for store data. Provides DI for both
 * production and test environments.
 *
 * Production: <StoreProvider> uses useArkStore() (push-based via ArkClient)
 * Tests: <StoreProvider store={mockData}> injects static data (no ArkClient needed)
 */

import React, { createContext, useContext } from "react";
import { useArkStore } from "../hooks/useArkStore.js";
import type { StoreData } from "../hooks/useArkStore.js";

const StoreContext = createContext<StoreData | null>(null);

interface StoreProviderProps {
  children: React.ReactNode;
  /** Inject store data directly (for tests). If omitted, uses live ArkClient. */
  store?: StoreData;
}

/** Live provider -- calls useArkStore() which requires ArkClientContext. */
function LiveStoreProvider({ children }: { children: React.ReactNode }) {
  const live = useArkStore();
  return (
    <StoreContext.Provider value={live}>
      {children}
    </StoreContext.Provider>
  );
}

export function StoreProvider({ children, store }: StoreProviderProps) {
  if (store) {
    return (
      <StoreContext.Provider value={store}>
        {children}
      </StoreContext.Provider>
    );
  }
  return <LiveStoreProvider>{children}</LiveStoreProvider>;
}

/** Read store data from context. Throws if used outside StoreProvider. */
export function useStoreContext(): StoreData {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStoreContext must be used within StoreProvider");
  return ctx;
}

/** Create a mock StoreData for tests. */
export function createMockStore(overrides?: Partial<StoreData>): StoreData {
  return {
    sessions: [],
    computes: [],
    agents: [],
    flows: [],
    unreadCounts: new Map(),
    snapshots: new Map(),
    computeLogs: new Map(),
    addComputeLog: () => {},
    initialLoading: false,
    refresh: () => {},
    ...overrides,
  };
}
