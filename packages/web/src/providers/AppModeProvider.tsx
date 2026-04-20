/**
 * AppModeProvider -- picks a mode-specific component binding once at boot and
 * exposes it through React context.
 *
 * Rationale
 * ---------
 * Ark has two deployment modes ("local" and "hosted") that differ in a handful
 * of user-facing affordances (file paths you can type, a "Browse" button,
 * basename-only display for opaque blob locators, ...). Historically, each
 * component that cared branched on a `useHostedMode()` boolean. That scatters
 * a cross-cutting concern across the component tree and makes it easy to ship
 * a new component that forgets the check.
 *
 * Instead, we fetch the mode once at provider setup and pick a binding:
 *
 *   - `LocalBinding`: `LocalRepoPicker`, `LocalFileInputRow`, `LocalFileInputAddEditor`.
 *   - `HostedBinding`: hosted variants that hide the typed-path affordances.
 *
 * Consumers call `useAppMode()` and render `binding.RepoPicker` / etc.
 * directly -- no `if (hosted)` in their bodies.
 *
 * The ONE runtime conditional is the binding-select in this module, which is
 * analogous to the backend's DI composition: a single point where we pick the
 * right implementation and hand it out polymorphically thereafter.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useServerConfig } from "../hooks/useServerConfig.js";
import { LocalBinding } from "../components/mode/local-binding.js";
import { HostedBinding } from "../components/mode/hosted-binding.js";
import type { AppModeBinding, AppModeKind } from "../components/mode/binding-types.js";

interface AppModeContextValue {
  kind: AppModeKind;
  binding: AppModeBinding;
  /** True while the initial config fetch is in flight. Components can render a
   * skeleton or fall back to hosted-safe defaults. */
  loading: boolean;
}

const AppModeContext = createContext<AppModeContextValue | null>(null);

export function AppModeProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useServerConfig();
  const value = useMemo<AppModeContextValue>(() => {
    // The server reports mode explicitly as `mode: "local" | "hosted"`. We
    // also accept the legacy `hosted: boolean` for back-compat with servers
    // that haven't shipped the new field yet.
    const kind: AppModeKind =
      (data as { mode?: AppModeKind })?.mode === "hosted" || (data as { hosted?: boolean })?.hosted
        ? "hosted"
        : "local";
    const binding: AppModeBinding = kind === "hosted" ? HostedBinding : LocalBinding;
    return { kind, binding, loading: isLoading };
  }, [data, isLoading]);

  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>;
}

/**
 * Resolve the active mode binding. Safe to call during loading -- the binding
 * defaults to local until the server config lands, which gives the right UX
 * on local builds (the common case). Hosted-only UX stabilizes on the next
 * render after the config fetch resolves.
 */
export function useAppMode(): AppModeContextValue {
  const ctx = useContext(AppModeContext);
  if (!ctx) {
    throw new Error("useAppMode must be used inside <AppModeProvider>");
  }
  return ctx;
}
