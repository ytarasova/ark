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
}

const MAX_HISTORY = 60;

export function ComputeView({ showCreate = false, onCloseCreate, onNavigate }: ComputeViewProps) {
  const queryClient = useQueryClient();
  const { data: computes = [] } = useComputeQuery();
  const [selected, setSelected] = useState<any>(null);
  const [actionMsg, setActionMsg] = useState<{ text: string; type: string } | null>(null);
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
      .catch(() => {});
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
        .catch(() => {});
    }, []),
    15000,
  );

  async function handleAction(action: string) {
    if (!selected) return;
    const name = selected.name || selected.id;
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
        case "delete":
          res = await api.deleteCompute(name);
          break;
        default:
          return;
      }
      if (res.ok !== false) {
        setActionMsg({ text: action + " successful", type: "success" });
        queryClient.invalidateQueries({ queryKey: ["compute"] });
      } else {
        setActionMsg({ text: res.message || "Action failed", type: "error" });
      }
    } catch (err: any) {
      setActionMsg({ text: err.message || "Action failed", type: "error" });
    }
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function handleCreate(form: any) {
    try {
      const config: any = { ...(form.templateConfig ?? {}) };
      if (form.size) config.size = form.size;
      if (form.region) config.region = form.region;
      await api.createCompute({ name: form.name, provider: form.provider, config });
      onCloseCreate?.();
      queryClient.invalidateQueries({ queryKey: ["compute"] });
    } catch (err: any) {
      setActionMsg({ text: err.message || "Failed to create compute", type: "error" });
      setTimeout(() => setActionMsg(null), 3000);
    }
  }

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
          {computes.map((c: any) => (
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
              </div>
              <Badge variant="secondary" className="text-[10px] shrink-0 ml-2">
                {c.provider || c.type || "local"}
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
              actionMsg={actionMsg}
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
