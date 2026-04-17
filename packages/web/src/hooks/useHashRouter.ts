import { useState, useEffect, useCallback } from "react";

const VALID_VIEWS = new Set([
  "dashboard",
  "sessions",
  "agents",
  "flows",
  "compute",
  "history",
  "memory",
  "tools",
  "schedules",
  "costs",
  "settings",
  "_design",
]);

export interface RouteState {
  view: string;
  subId: string | null;
}

function parseHash(): RouteState {
  const raw = window.location.hash.replace(/^#\/?/, "");
  if (!raw) return { view: "sessions", subId: null };
  const parts = raw.split("/");
  const view = parts[0];
  if (!VALID_VIEWS.has(view)) return { view: "sessions", subId: null };
  const subId = parts.slice(1).join("/") || null;
  return { view, subId };
}

function writeHash(view: string, subId?: string | null) {
  const hash = subId ? `#/${view}/${subId}` : `#/${view}`;
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

  const navigate = useCallback((view: string, subId?: string | null) => {
    writeHash(view, subId);
    setRoute({ view, subId: subId ?? null });
  }, []);

  const setSubId = useCallback((subId: string | null) => {
    setRoute((prev) => {
      writeHash(prev.view, subId);
      return { ...prev, subId };
    });
  }, []);

  return { view: route.view, subId: route.subId, navigate, setSubId };
}
