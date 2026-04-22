/**
 * Right-side panel for editing a selected flow stage's properties.
 *
 * Fields: name, agent, gate, condition, verify scripts, on_failure, outcome routes.
 */

import { useState, useCallback, useEffect } from "react";
import type { FlowStageDefinition } from "../pipeline/types.js";
import { RichSelect } from "../ui/RichSelect.js";

export interface FlowPropertiesPanelProps {
  stage: FlowStageDefinition | null;
  agents: string[];
  allStageNames: string[];
  readOnly: boolean;
  onUpdate: (stage: FlowStageDefinition) => void;
  onDelete: () => void;
}

const GATE_OPTIONS = ["auto", "manual", "condition"] as const;
const FAILURE_OPTIONS = ["fail", "retry(1)", "retry(2)", "retry(3)"] as const;

export function FlowPropertiesPanel({
  stage,
  agents,
  allStageNames: _allStageNames,
  readOnly,
  onUpdate,
  onDelete,
}: FlowPropertiesPanelProps) {
  const [localStage, setLocalStage] = useState<FlowStageDefinition | null>(stage);

  useEffect(() => {
    setLocalStage(stage);
  }, [stage]);

  const update = useCallback(
    (partial: Partial<FlowStageDefinition>) => {
      if (!localStage) return;
      const updated = { ...localStage, ...partial };
      setLocalStage(updated);
      onUpdate(updated);
    },
    [localStage, onUpdate],
  );

  if (!localStage) {
    return (
      <div
        style={{
          background: "var(--card)",
          borderLeft: "1px solid var(--border)",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--muted-foreground)",
          fontSize: 12,
        }}
      >
        Select a stage
      </div>
    );
  }

  const outcomes = localStage.on_outcome || {};
  const outcomeEntries = Object.entries(outcomes);

  return (
    <div
      style={{
        background: "var(--card)",
        borderLeft: "1px solid var(--border)",
        height: "100%",
        overflowY: "auto",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "14px 16px 10px",
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--muted-foreground)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        Stage Properties -- {localStage.name}
      </div>

      {/* Name */}
      <PropSection label="Name">
        <PropInput value={localStage.name} readOnly={readOnly} onChange={(v) => update({ name: v })} />
      </PropSection>

      {/* Agent */}
      <PropSection label="Agent">
        <PropSelect
          value={localStage.agent || ""}
          readOnly={readOnly}
          options={[{ value: "", label: "-- agent --" }, ...agents.map((a) => ({ value: a, label: a }))]}
          onChange={(v) => update({ agent: v || null })}
        />
      </PropSection>

      {/* Gate */}
      <PropSection label="Gate">
        <div style={{ display: "flex", gap: 2, background: "var(--background)", borderRadius: 5, padding: 2 }}>
          {GATE_OPTIONS.map((g) => {
            const isActive = localStage.gate === g;
            const activeColor =
              g === "auto" ? "var(--completed)" : g === "manual" ? "var(--waiting)" : "var(--running)";
            return (
              <button
                key={g}
                disabled={readOnly}
                onClick={() => update({ gate: g })}
                style={{
                  flex: 1,
                  textAlign: "center",
                  fontSize: 11,
                  padding: "5px 8px",
                  border: "none",
                  borderRadius: 4,
                  background: isActive ? activeColor : "none",
                  color: isActive ? "#fff" : "var(--muted-foreground)",
                  cursor: readOnly ? "default" : "pointer",
                  fontWeight: 500,
                }}
              >
                {g.charAt(0).toUpperCase() + g.slice(1)}
              </button>
            );
          })}
        </div>
      </PropSection>

      {/* Condition expression (visible when gate = condition) */}
      {localStage.gate === "condition" && (
        <PropSection label="Condition expression">
          <PropInput
            value={(localStage as any).conditionExpr || ""}
            readOnly={readOnly}
            placeholder="session.review_result === 'approved'"
            onChange={(v) => update({ ...localStage, conditionExpr: v } as any)}
          />
        </PropSection>
      )}

      {/* Verify scripts */}
      <PropSection label="Verify scripts">
        <textarea
          value={(localStage.verify || []).join("\n")}
          readOnly={readOnly}
          placeholder={"bun test\nmake lint"}
          onChange={(e) => update({ verify: e.target.value.split("\n").filter((l) => l.trim()) })}
          style={{
            width: "100%",
            padding: "6px 10px",
            fontSize: 11,
            fontFamily: '"JetBrains Mono", monospace',
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            color: "var(--foreground)",
            outline: "none",
            resize: "vertical",
            minHeight: 60,
            lineHeight: 1.5,
          }}
        />
      </PropSection>

      {/* On failure */}
      <PropSection label="On failure">
        <PropSelect
          value={localStage.on_failure || "fail"}
          readOnly={readOnly}
          options={FAILURE_OPTIONS.map((f) => ({ value: f, label: f }))}
          onChange={(v) => update({ on_failure: v === "fail" ? null : v })}
        />
      </PropSection>

      {/* Outcome routes */}
      <PropSection label="Outcome routes">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {outcomeEntries.map(([label, target], i) => (
            <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                value={label}
                readOnly={readOnly}
                placeholder="outcome"
                onChange={(e) => {
                  const newOutcomes = { ...outcomes };
                  delete newOutcomes[label];
                  newOutcomes[e.target.value] = target;
                  update({ on_outcome: newOutcomes });
                }}
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  fontSize: 11,
                  fontFamily: '"JetBrains Mono", monospace',
                  background: "var(--background)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: "var(--foreground)",
                  outline: "none",
                }}
              />
              <span style={{ color: "var(--muted-foreground)", fontSize: 11, flexShrink: 0 }}>-&gt;</span>
              <input
                value={target}
                readOnly={readOnly}
                placeholder="target stage"
                onChange={(e) => {
                  const newOutcomes = { ...outcomes, [label]: e.target.value };
                  update({ on_outcome: newOutcomes });
                }}
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  fontSize: 11,
                  fontFamily: '"JetBrains Mono", monospace',
                  background: "var(--background)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: "var(--foreground)",
                  outline: "none",
                }}
              />
              {!readOnly && (
                <button
                  onClick={() => {
                    const newOutcomes = { ...outcomes };
                    delete newOutcomes[label];
                    update({ on_outcome: newOutcomes });
                  }}
                  style={{
                    fontSize: 10,
                    color: "var(--failed)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "2px 4px",
                  }}
                >
                  x
                </button>
              )}
            </div>
          ))}
          {!readOnly && (
            <button
              onClick={() => {
                const newOutcomes = { ...outcomes, "": "" };
                update({ on_outcome: newOutcomes });
              }}
              style={{
                fontSize: 10,
                color: "var(--primary)",
                background: "none",
                border: "1px dashed var(--border)",
                borderRadius: 4,
                padding: "4px 10px",
                cursor: "pointer",
                width: "100%",
              }}
            >
              + Add outcome route
            </button>
          )}
        </div>
      </PropSection>

      {/* Task prompt */}
      <PropSection label="Task prompt">
        <textarea
          value={localStage.task || ""}
          readOnly={readOnly}
          placeholder="Describe what this stage should do..."
          onChange={(e) => update({ task: e.target.value })}
          style={{
            width: "100%",
            padding: "6px 10px",
            fontSize: 11,
            fontFamily: '"JetBrains Mono", monospace',
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            color: "var(--foreground)",
            outline: "none",
            resize: "vertical",
            minHeight: 100,
            lineHeight: 1.5,
          }}
        />
      </PropSection>

      {/* Delete button */}
      {!readOnly && (
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
          <button
            onClick={onDelete}
            style={{
              fontSize: 11,
              fontWeight: 500,
              padding: "5px 12px",
              borderRadius: 5,
              border: "1px solid rgba(248, 113, 113, 0.3)",
              background: "rgba(248, 113, 113, 0.12)",
              color: "#f87171",
              cursor: "pointer",
              width: "100%",
            }}
          >
            Delete Stage
          </button>
        </div>
      )}
    </div>
  );
}

function PropSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
      <label
        style={{
          display: "block",
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--muted-foreground)",
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function PropInput({
  value,
  readOnly,
  placeholder,
  onChange,
}: {
  value: string;
  readOnly: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      value={value}
      readOnly={readOnly}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "6px 10px",
        fontSize: 12,
        fontFamily: '"JetBrains Mono", monospace',
        background: "var(--background)",
        border: "1px solid var(--border)",
        borderRadius: 5,
        color: "var(--foreground)",
        outline: "none",
      }}
    />
  );
}

function PropSelect({
  value,
  readOnly,
  options,
  onChange,
}: {
  value: string;
  readOnly: boolean;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <RichSelect
      value={value}
      disabled={readOnly}
      onChange={onChange}
      options={options.map((o) => ({ value: o.value, label: o.label }))}
    />
  );
}
