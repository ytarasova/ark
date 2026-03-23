/**
 * React Context for store data. Provides DI for both
 * production and test environments.
 *
 * Production: <StoreProvider> uses useStore() polling
 * Tests: <StoreProvider store={mockData}> injects static data
 */

import React, { createContext, useContext } from "react";
import { useStore } from "../hooks/useStore.js";
import type { StoreData } from "../hooks/useStore.js";

const StoreContext = createContext<StoreData | null>(null);

interface StoreProviderProps {
  children: React.ReactNode;
  /** Inject store data directly (for tests). If omitted, uses live polling. */
  store?: StoreData;
}

export function StoreProvider({ children, store }: StoreProviderProps) {
  const live = useStore();
  return (
    <StoreContext.Provider value={store ?? live}>
      {children}
    </StoreContext.Provider>
  );
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
    refreshing: false,
    refresh: () => {},
    ...overrides,
  };
}
