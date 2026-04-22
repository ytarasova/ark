/**
 * Toolbar for the FlowEditor.
 *
 * Actions: Add Stage, Auto-layout, Validate, Export YAML, Import YAML.
 * Includes a View/Edit mode toggle.
 */

import { memo, useState, useCallback, useRef } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import YAML from "yaml";
import type { FlowDefinition, FlowStageDefinition, FlowEdgeDefinition } from "../pipeline/types.js";

export interface FlowToolbarProps {
  flowName: string;
  readOnly: boolean;
  onToggleMode: () => void;
  onAddStage: () => void;
  onAutoLayout: () => void;
  onValidate: () => string[];
  flow: FlowDefinition;
  onImport: (flow: FlowDefinition) => void;
}

function FlowToolbarComponent({
  flowName,
  readOnly,
  onToggleMode,
  onAddStage,
  onAutoLayout,
  onValidate,
  flow,
  onImport,
}: FlowToolbarProps) {
  const [showYaml, setShowYaml] = useState(false);
  const [validationMsg, setValidationMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleValidate = useCallback(() => {
    const errors = onValidate();
    if (errors.length === 0) {
      setValidationMsg({
        text: `Flow is valid: ${flow.stages.length} stages, ${flow.edges.length} edges, no cycles detected, all stages reachable.`,
        isError: false,
      });
    } else {
      setValidationMsg({ text: errors.join("; "), isError: true });
    }
    setTimeout(() => setValidationMsg(null), 5000);
  }, [onValidate, flow]);

  const handleExportYaml = useCallback(() => {
    setShowYaml(true);
  }, []);

  const yamlContent = generateYaml(flow);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const text = ev.target?.result as string;
          const parsed = parseYaml(text);
          if (parsed) onImport(parsed);
        } catch {
          setValidationMsg({ text: "Failed to parse YAML file", isError: true });
          setTimeout(() => setValidationMsg(null), 3000);
        }
      };
      reader.readAsText(file);
      // Reset so same file can be re-imported
      e.target.value = "";
    },
    [onImport],
  );

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          height: 48,
          background: "var(--card)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>Flow Editor</span>
          <span
            style={{
              fontSize: 12,
              fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace',
              fontVariantNumeric: "tabular-nums",
              color: "var(--primary)",
              padding: "3px 10px",
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {flowName}
          </span>

          {/* Mode toggle */}
          <div
            style={{
              display: "flex",
              background: "var(--background)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              padding: 2,
              gap: 2,
              marginLeft: 16,
            }}
          >
            <ModeButton label="View" active={readOnly} onClick={readOnly ? undefined : onToggleMode} />
            <ModeButton label="Edit" active={!readOnly} onClick={readOnly ? onToggleMode : undefined} />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {!readOnly && <ToolbarButton label="+ Add Stage" onClick={onAddStage} />}
          {!readOnly && <ToolbarButton label="Auto-layout" onClick={onAutoLayout} />}
          <ToolbarButton label="Validate" onClick={handleValidate} variant="success" />
          <ToolbarButton label="Export YAML" onClick={handleExportYaml} />
          {!readOnly && (
            <>
              <ToolbarButton label="Import YAML" onClick={handleImportClick} />
              <input
                ref={fileInputRef}
                type="file"
                accept=".yaml,.yml"
                style={{ display: "none" }}
                onChange={handleFileChange}
              />
            </>
          )}
        </div>
      </div>

      {/* Validation message */}
      {validationMsg && (
        <div
          className={`flow-validation-bar ${validationMsg.isError ? "invalid" : "valid"}`}
          style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 50 }}
        >
          {validationMsg.isError ? (
            <AlertCircle size={14} aria-hidden="true" />
          ) : (
            <Check size={14} aria-hidden="true" />
          )}
          <span>{validationMsg.text}</span>
        </div>
      )}

      {/* YAML export modal */}
      {showYaml && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--bg-overlay, rgba(0, 0, 0, 0.6))",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
          onClick={() => setShowYaml(false)}
        >
          <div
            style={{
              background: "var(--bg-popover, var(--card))",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              width: 600,
              maxHeight: "80vh",
              overflow: "hidden",
              boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600 }}>Export YAML -- {flowName}</span>
              <button
                onClick={() => setShowYaml(false)}
                aria-label="Close"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--fg-muted, var(--muted-foreground))",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 4,
                  borderRadius: "var(--radius-sm)",
                  transition: "color 150ms cubic-bezier(0.32, 0.72, 0, 1)",
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <div style={{ padding: 16, overflowY: "auto", maxHeight: "60vh" }}>
              <pre className="yaml-code-block">{yamlContent}</pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ToolbarButton({
  label,
  onClick,
  variant,
}: {
  label: string;
  onClick: () => void;
  variant?: "success" | "danger";
}) {
  const bg = "var(--bg-card, var(--secondary))";
  let color = "var(--fg-muted, var(--muted-foreground))";
  const borderColor = "var(--border)";

  if (variant === "success") {
    color = "var(--completed)";
  } else if (variant === "danger") {
    color = "var(--failed)";
  }

  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: "5px 12px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${borderColor}`,
        background: bg,
        color,
        cursor: "pointer",
        transition: "background-color 150ms cubic-bezier(0.32, 0.72, 0, 1), color 150ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
    >
      {label}
    </button>
  );
}

function ModeButton({ label, active, onClick }: { label: string; active: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        padding: "4px 12px",
        border: "none",
        borderRadius: "var(--radius-sm)",
        background: active ? "var(--primary)" : "none",
        color: active ? "var(--primary-foreground, var(--fg))" : "var(--fg-muted, var(--muted-foreground))",
        cursor: onClick ? "pointer" : "default",
        fontWeight: 500,
        transition: "background-color 150ms cubic-bezier(0.32, 0.72, 0, 1), color 150ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
    >
      {label}
    </button>
  );
}

/**
 * Serialize a flow definition to YAML. Omits nullish / empty fields
 * so round-trips stay clean.
 */
function generateYaml(flow: FlowDefinition): string {
  const doc: Record<string, unknown> = { name: flow.name };
  if (flow.description) doc.description = flow.description;
  doc.stages = flow.stages.map((s) => {
    const stage: Record<string, unknown> = { name: s.name };
    if (s.agent) stage.agent = s.agent;
    if (s.action) stage.action = s.action;
    if (s.type) stage.type = s.type;
    stage.gate = s.gate;
    if (s.task) stage.task = s.task;
    if (s.depends_on && s.depends_on.length > 0) stage.depends_on = s.depends_on;
    if (s.on_failure) stage.on_failure = s.on_failure;
    if (s.verify && s.verify.length > 0) stage.verify = s.verify;
    if (s.optional) stage.optional = s.optional;
    if (s.on_outcome && Object.keys(s.on_outcome).length > 0) stage.on_outcome = s.on_outcome;
    return stage;
  });
  if (flow.edges.length > 0) {
    doc.edges = flow.edges.map((e) => {
      const edge: Record<string, unknown> = { from: e.from, to: e.to };
      if (e.condition) edge.condition = e.condition;
      if (e.label) edge.label = e.label;
      return edge;
    });
  }
  return YAML.stringify(doc);
}

/**
 * Parse YAML text into a FlowDefinition. Returns null when the input
 * is malformed or missing the required `name` field. Callers wrap
 * this in a try/catch anyway -- we additionally swallow YAML parse
 * errors here so behavior matches the previous placeholder.
 */
function parseYaml(text: string): FlowDefinition | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : "";
  if (!name) return null;

  const rawStages = Array.isArray(obj.stages) ? obj.stages : [];
  const stages: FlowStageDefinition[] = rawStages.map((raw) => {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      name: typeof s.name === "string" ? s.name : "",
      agent: typeof s.agent === "string" ? s.agent : null,
      action: typeof s.action === "string" ? s.action : null,
      type: typeof s.type === "string" ? s.type : null,
      gate: typeof s.gate === "string" ? s.gate : "auto",
      task: typeof s.task === "string" ? s.task : null,
      depends_on: Array.isArray(s.depends_on) ? s.depends_on.filter((v): v is string => typeof v === "string") : [],
      on_failure: typeof s.on_failure === "string" ? s.on_failure : null,
      verify: Array.isArray(s.verify) ? s.verify.filter((v): v is string => typeof v === "string") : [],
      optional: s.optional === true,
      on_outcome:
        s.on_outcome && typeof s.on_outcome === "object"
          ? (Object.fromEntries(
              Object.entries(s.on_outcome as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [
                string,
                string,
              ][],
            ) as Record<string, string>)
          : undefined,
    };
  });

  const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];
  const edges: FlowEdgeDefinition[] = rawEdges.map((raw) => {
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      from: typeof e.from === "string" ? e.from : "",
      to: typeof e.to === "string" ? e.to : "",
      condition: typeof e.condition === "string" ? e.condition : null,
      label: typeof e.label === "string" ? e.label : null,
    };
  });

  return {
    name,
    description: typeof obj.description === "string" ? obj.description : "",
    stages,
    edges,
  };
}

export const FlowToolbar = memo(FlowToolbarComponent);
