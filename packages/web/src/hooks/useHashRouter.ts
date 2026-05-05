import { useState, useEffect, useCallback } from "react";

const VALID_VIEWS = new Set([
  "sessions",
  "agents",
  "flows",
  "compute",
  "history",
  "tools",
  "schedules",
  "costs",
  "integrations",
  "settings",
  "_design",
]);

export interface RouteState {
  view: string;
  subId: string | null;
  tab: string | null;
}

function parseHash(): RouteState {
  const raw = window.location.hash.replace(/^#\/?/, "");
  if (!raw) return { view: "sessions", subId: null, tab: null };
  const parts = raw.split("/");
  let view = parts[0];
  if (view === "dashboard") view = "sessions"; // redirect legacy dashboard URL
  if (!VALID_VIEWS.has(view)) return { view: "sessions", subId: null, tab: null };
  // Empty string between slashes (e.g. #/agents//runtimes) is treated as a
  // missing subId. This lets views carry a tab without a selected item.
  const subId = parts[1] ? parts[1] : null;
  const tab = parts[2] || null;
  return { view, subId, tab };
}

function writeHash(view: string, subId?: string | null, tab?: string | null) {
  let hash = `#/${view}`;
  if (subId) {
    hash += `/${subId}`;
    if (tab) hash += `/${tab}`;
  } else if (tab) {
    // Allow a tab without a subId -- render as `#/view//tab`.
    hash += `//${tab}`;
  }
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}

export function useHashRouter() {
  const [route, setRoute] = useState<RouteState>(parseHash);

  useEffect(() => {
    function onHashChange() {
      setRoute(parseHash());
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((view: string, subId?: string | null, tab?: string | null) => {
    writeHash(view, subId, tab);
    setRoute({ view, subId: subId ?? null, tab: tab ?? null });
  }, []);

  const setSubId = useCallback((subId: string | null, tab?: string | null) => {
    setRoute((prev) => {
      // When subId changes, clear tab unless explicitly provided
      const subChanged = subId !== prev.subId;
      const newTab = tab !== undefined ? tab : subChanged ? null : prev.tab;
      writeHash(prev.view, subId, newTab);
      return { ...prev, subId, tab: newTab };
    });
  }, []);

  const setTab = useCallback((tab: string | null) => {
    setRoute((prev) => {
      writeHash(prev.view, prev.subId, tab);
      return { ...prev, tab };
    });
  }, []);

  return { view: route.view, subId: route.subId, tab: route.tab, navigate, setSubId, setTab };
}
