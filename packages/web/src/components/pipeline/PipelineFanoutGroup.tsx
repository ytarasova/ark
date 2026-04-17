/**
 * Fan-out group rendering for parallel workers.
 *
 * Displays workers in a vertical stack with a shared label.
 * Clicking any worker expands a side-by-side comparison panel.
 */

import { memo, useState } from "react";
import type { PipelineStage, ToolCallDetail } from "./types.js";

interface WorkerDetail {
  name: string;
  status: string;
  duration: number | null;
  cost: number | null;
  summary: string | null;
  toolCalls: ToolCallDetail[];
}

export interface PipelineFanoutGroupProps {
  parentStage: string;
  joinStage: string;
  workers: PipelineStage[];
  onWorkerClick?: (workerName: string) => void;
  isExpanded: boolean;
  onToggle: () => void;
  workerDetails?: WorkerDetail[];
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

function PipelineFanoutGroupComponent({ workers, isExpanded, onToggle, workerDetails }: PipelineFanoutGroupProps) {
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null);

  if (!isExpanded) return null;

  const details =
    workerDetails ||
    workers.map((w) => ({
      name: w.name,
      status: w.status,
      duration: w.duration,
      cost: w.cost,
      summary: w.summary,
      toolCalls: w.toolCalls.map((t) => ({ name: t.name, args: "", duration: 0 })),
    }));

  const cols = Math.min(details.length, 4);

  return (
    <div className="pipeline-detail-panel" style={{ margin: "0 20px 16px" }}>
      <div
        style={{
          background: "var(--background)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "16px 20px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>
            Fan-out -- {workers.length} workers
          </span>
          <button
            onClick={onToggle}
            style={{
              fontSize: 11,
              color: "var(--muted-foreground)",
              cursor: "pointer",
              background: "none",
              border: "none",
              padding: "2px 6px",
              borderRadius: 3,
            }}
          >
            Close
          </button>
        </div>

        <div className="pipeline-fanout-detail" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {details.map((w) => (
            <div
              key={w.name}
              className="pipeline-fanout-cell"
              onClick={() => setSelectedWorker(selectedWorker === w.name ? null : w.name)}
              style={{ cursor: "pointer" }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--foreground)" }}>{w.name}</span>
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: '"JetBrains Mono", monospace',
                    padding: "2px 8px",
                    borderRadius: 4,
                    background:
                      w.status === "completed"
                        ? "rgba(52, 211, 153, 0.12)"
                        : w.status === "running"
                          ? "rgba(124, 106, 239, 0.12)"
                          : "var(--secondary)",
                    color:
                      w.status === "completed"
                        ? "#34d399"
                        : w.status === "running"
                          ? "var(--primary)"
                          : "var(--muted-foreground)",
                  }}
                >
                  {w.status}
                  {w.duration ? `, ${formatDuration(w.duration)}` : ""}
                </span>
              </div>
              {w.summary && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--muted-foreground)",
                    lineHeight: 1.6,
                    marginBottom: 8,
                  }}
                >
                  {w.summary}
                </div>
              )}
              {w.toolCalls.length > 0 && (
                <div
                  style={{
                    fontSize: 10,
                    fontFamily: '"JetBrains Mono", monospace',
                    color: "var(--muted-foreground)",
                    lineHeight: 1.6,
                    opacity: 0.7,
                  }}
                >
                  {w.toolCalls.map((t, i) => (
                    <div key={i}>&gt; {t.name}</div>
                  ))}
                </div>
              )}
              {w.cost !== null && (
                <div
                  style={{
                    fontSize: 10,
                    fontFamily: '"JetBrains Mono", monospace',
                    color: w.status === "running" ? "var(--primary)" : "#34d399",
                    marginTop: 6,
                  }}
                >
                  Cost: ${w.cost?.toFixed(2)}
                  {w.status === "running" ? " (running)" : ""}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const PipelineFanoutGroup = memo(PipelineFanoutGroupComponent);
