import React, { createContext, useContext } from "react";
import type { AppContext } from "../../core/app.js";

const AppCtx = createContext<AppContext>(null!);

export function AppProvider({ app, children }: { app: AppContext; children: React.ReactNode }) {
  return <AppCtx.Provider value={app}>{children}</AppCtx.Provider>;
}

export function useAppContext(): AppContext {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useAppContext must be used within <AppProvider>");
  return ctx;
}
