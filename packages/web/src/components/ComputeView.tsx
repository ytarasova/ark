import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useComputeQuery } from "../hooks/useComputeQueries.js";
import { useSmartPoll } from "../hooks/useSmartPoll.js";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";
import { Server } from "lucide-react";
import { statusDotColor } from "./compute/helpers.js";
import { NewComputeForm } from "./compute/NewComputeForm.js";
import { ComputeDetailPanel } from "./compute/ComputeDetailPanel.js";
import type { ComputeSnapshot, MetricHistoryPoint } from "./compute/types.js";

interface ComputeViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
  onNavigate?: (view: string, subId?: string) => void;
  initialSelectedName?: string | null;
  onSelectedChange?: (name: string | null) => void;
  onToast?: (msg: string, type: string) => void;
}

const MAX_HISTORY = 60;

export function ComputeView({
  showCreate = false,
  onCloseCreate,
  onNavigate,
  initialSelectedName,
  onSelectedChange,
  onToast,
}: ComputeViewProps) {
  const queryClient = useQueryClient();
  const { data: computes = [] } = useComputeQuery();
  const [selectedInternal, setSelectedInternal] = useState<any>(null);
  const selected =
    selectedInternal ??
    (initialSelectedName ? computes.find((c: any) => (c.name || c.id) === initialSelectedName) : null);
  const setSelected = (item: any) => {
    setSelectedInternal(item);
    onSelectedChange?.(item ? item.name || item.id || null : null);
  };
  const [snapshot, setSnapshot] = useState<ComputeSnapshot | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [metricsState, setMetricsState] = useState<"loading" | "loaded" | "error">("loading");
  const metricHistoryRef = useRef<Map<string, MetricHistoryPoint[]>>(new Map());
  const [metricHistory, setMetricHistory] = useState<MetricHistoryPoint[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getSessions({ status: "running" })
      .then((data) => {
        if (!cancelled) setSessions(data);
      })
      .catch((err) => {
        console.warn(
          `ComputeView: initial getSessions failed (running-sessions list will be empty):`,
          err instanceof Error ? err.message : err,
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSnapshot = useCallback(() => {
    if (!selected) {
      setSnapshot(null);
      setMetricsState("loading");
      return;
    }
    const name = selected.name || selected.id;
    api
      .getComputeSnapshot(name === "local" ? undefined : name)
      .then((snap) => {
        if (!mountedRef.current) return;
        setSnapshot(snap);
        setMetricsState(snap?.metrics ? "loaded" : "error");
        if (snap?.metrics) {
          const key = name;
          const history = metricHistoryRef.current.get(key) ?? [];
          history.push({ t: Date.now(), cpu: snap.metrics.cpu, mem: snap.metrics.memPct, disk: snap.metrics.diskPct });
          if (history.length > MAX_HISTORY) history.shift();
          metricHistoryRef.current.set(key, history);
          setMetricHistory([...history]);
        }
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setSnapshot(null);
        setMetricsState("error");
      });
  }, [selected]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  useSmartPoll(loadSnapshot, 5000);

  useSmartPoll(
    useCallback(() => {
      api
        .getSessions({ status: "running" })
        .then((data) => {
          if (mountedRef.current) setSessions(data);
        })
        .catch((err) => {
          console.warn(
            `ComputeView: poll getSessions failed (next 15s tick will retry):`,
            err instanceof Error ? err.message : err,
          );
        });
    }, []),
    15000,
  );

  const [pendingAction, setPendingAction] = useState<string | null>(null);

  async function handleAction(action: string) {
    if (!selected) return;
    if (pendingAction) return; // block double-clicks while one is in flight
    const name = selected.name || selected.id;
    const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
    setPendingAction(action);
    try {
      let res: any;
      switch (action) {
        case "provision":
          res = await api.provisionCompute(name);
          break;
        case "start":
          res = await api.startCompute(name);
          break;
        case "stop":
          res = await api.stopCompute(name);
          break;
        case "destroy":
          res = await api.destroyCompute(name);
          break;
        default:
          setPendingAction(null);
          return;
      }
      if (res.ok !== false) {
        onToast?.(`${actionLabel} succeeded for '${name}'`, "success");
        // After destroy, the row is gone -- clear the selection so the user
        // doesn't stare at a 404 panel.
        if (action === "destroy") {
          setSelected(null);
        }
        // For provision on a template, the server returns the clone name.
        // Navigate the user straight to the new concrete row so they can
        // watch it come up.
        if (action === "provision" && res?.name && res.name !== name) {
          onToast?.(`Cloned '${name}' into '${res.name}'`, "success");
          onSelectedChange?.(res.name);
        }
        await queryClient.invalidateQueries({ queryKey: ["compute"] });
        loadSnapshot();
      } else {
        onToast?.(res.message || `${actionLabel} failed`, "error");
      }
    } catch (err: any) {
      onToast?.(err?.message || `${actionLabel} failed`, "error");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleCreate(form: any) {
    try {
      const config: any = { ...(form.templateConfig ?? {}) };
      if (form.size) config.size = form.size;
      if (form.region) config.region = form.region;
      // Send compute + runtime axes. Provider is omitted -- the server
      // derives it via pairToProvider for back-compat reads. is_template
      // rides on the same RPC -- templates and concrete targets use the
      // same create surface.
      await api.createCompute({
        name: form.name,
        compute: form.compute,
        runtime: form.runtime,
        config,
        ...(form.is_template ? { is_template: true } : {}),
      } as any);
      onCloseCreate?.();
      queryClient.invalidateQueries({ queryKey: ["compute"] });
    } catch (err: any) {
      onToast?.(err?.message || "Failed to create compute", "error");
    }
  }

  // Filter: concrete | template. Default shows concrete -- templates are a
  // less-common secondary view that the user opts into explicitly.
  const [listFilter, setListFilter] = useState<"concrete" | "template">("concrete");
  const visibleComputes = computes.filter((c: any) => (listFilter === "template" ? !!c.is_template : !c.is_template));

  if (!computes.length && !showCreate) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <Server size={28} className="text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No compute targets</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
        <div className="border-r border-border overflow-y-auto" role="listbox" aria-label="Compute targets">
          {/* Filter bar: computes | templates. No "All" -- showing both in
              a flat list was confusing given they share a table but answer
              different questions. */}
          <div className="flex gap-1 px-3 py-2 border-b border-border/50 text-[11px]">
            {(["concrete", "template"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={listFilter === f}
                onClick={() => setListFilter(f)}
                className={cn(
                  "px-2 py-1 rounded transition-colors",
                  listFilter === f
                    ? "bg-accent text-foreground font-semibold"
                    : "text-muted-foreground hover:bg-accent/40",
                )}
              >
                {f === "concrete" ? "Computes" : "Templates"}
              </button>
            ))}
          </div>
          {visibleComputes.map((c: any) => (
            <div
              key={c.name || c.id}
              role="option"
              aria-selected={(selected?.name || selected?.id) === (c.name || c.id)}
              className={cn(
                "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                "hover:bg-accent",
                (selected?.name || selected?.id) === (c.name || c.id) &&
                  "bg-accent border-l-2 border-l-primary font-semibold",
              )}
              onClick={() => {
                setSelected(c);
                setMetricsState("loading");
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={cn("inline-block w-2 h-2 rounded-full shrink-0", statusDotColor(c.status || "unknown"))}
                />
                <span className="text-foreground truncate">{c.name || c.id}</span>
                {/* Tiny pill: TEMPLATE vs COMPUTE. Users should never wonder
                    which they clicked on. Styled to match the existing
                    Badge component so the page reads consistently. */}
                <Badge
                  variant={c.is_template ? "outline" : "secondary"}
                  className="text-[9px] shrink-0 uppercase tracking-wider"
                >
                  {c.is_template ? "template" : "compute"}
                </Badge>
              </div>
              <Badge variant="secondary" className="text-[10px] shrink-0 ml-2">
                {/* Prefer compute_kind + runtime_kind; fall back to the
                    legacy provider / type string for older rows. */}
                {(c as any).compute_kind && (c as any).runtime_kind
                  ? `${(c as any).compute_kind}/${(c as any).runtime_kind}`
                  : c.provider || c.type || "local"}
              </Badge>
            </div>
          ))}
        </div>
        <div className="overflow-y-auto bg-background">
          {showCreate ? (
            <NewComputeForm onClose={() => onCloseCreate?.()} onSubmit={handleCreate} />
          ) : selected ? (
            <ComputeDetailPanel
              compute={selected}
              snapshot={snapshot}
              metricHistory={metricHistory}
              sessions={sessions}
              onAction={handleAction}
              pendingAction={pendingAction}
              metricsState={metricsState}
              onRetryMetrics={loadSnapshot}
              onNavigateToSession={(sessionId) => onNavigate?.("sessions", sessionId)}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Select a compute target
            </div>
          )}
        </div>
      </div>
    </>
  );
}
