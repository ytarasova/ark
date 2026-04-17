/**
 * Toolbar for the FlowEditor.
 *
 * Actions: Add Stage, Auto-layout, Validate, Export YAML, Import YAML.
 * Includes a View/Edit mode toggle.
 */

import { memo, useState, useCallback, useRef } from "react";
import type { FlowDefinition } from "../pipeline/types.js";

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
              fontFamily: '"JetBrains Mono", monospace',
              color: "var(--primary)",
              padding: "3px 10px",
              background: "rgba(124, 106, 239, 0.12)",
              borderRadius: 4,
            }}
          >
            {flowName}
          </span>

          {/* Mode toggle */}
          <div
            style={{
              display: "flex",
              background: "var(--background)",
              borderRadius: 5,
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
          <span>{validationMsg.isError ? "!" : "\u2713"}</span>
          <span>{validationMsg.text}</span>
        </div>
      )}

      {/* YAML export modal */}
      {showYaml && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
          onClick={() => setShowYaml(false)}
        >
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              width: 600,
              maxHeight: "80vh",
              overflow: "hidden",
              boxShadow: "0 16px 48px rgba(0, 0, 0, 0.5)",
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
                style={{
                  fontSize: 11,
                  color: "var(--muted-foreground)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "4px 8px",
                  borderRadius: 3,
                }}
              >
                Close
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
  let bg = "var(--secondary)";
  let color = "var(--muted-foreground)";
  let borderColor = "var(--border)";

  if (variant === "success") {
    bg = "rgba(52, 211, 153, 0.12)";
    color = "#34d399";
    borderColor = "rgba(52, 211, 153, 0.3)";
  } else if (variant === "danger") {
    bg = "rgba(248, 113, 113, 0.12)";
    color = "#f87171";
    borderColor = "rgba(248, 113, 113, 0.3)";
  }

  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: "5px 12px",
        borderRadius: 5,
        border: `1px solid ${borderColor}`,
        background: bg,
        color,
        cursor: "pointer",
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
        borderRadius: 4,
        background: active ? "var(--primary)" : "none",
        color: active ? "#fff" : "var(--muted-foreground)",
        cursor: onClick ? "pointer" : "default",
        fontWeight: 500,
      }}
    >
      {label}
    </button>
  );
}

/**
 * Generate YAML string from a flow definition.
 * Simple serializer -- no external YAML library needed.
 */
function generateYaml(flow: FlowDefinition): string {
  const lines: string[] = [];
  lines.push(`name: ${flow.name}`);
  if (flow.description) lines.push(`description: "${flow.description}"`);
  lines.push("");
  lines.push("stages:");
  for (const s of flow.stages) {
    lines.push(`  - name: ${s.name}`);
    if (s.agent) lines.push(`    agent: ${s.agent}`);
    if (s.action) lines.push(`    action: ${s.action}`);
    lines.push(`    gate: ${s.gate}`);
    if (s.on_failure) lines.push(`    on_failure: "${s.on_failure}"`);
    if (s.verify && s.verify.length > 0) {
      lines.push("    verify:");
      for (const v of s.verify) lines.push(`      - "${v}"`);
    }
    if (s.task) {
      lines.push("    task: |");
      for (const line of s.task.split("\n")) {
        lines.push(`      ${line}`);
      }
    }
    if (s.on_outcome && Object.keys(s.on_outcome).length > 0) {
      lines.push("    on_outcome:");
      for (const [label, target] of Object.entries(s.on_outcome)) {
        lines.push(`      ${label}: ${target}`);
      }
    }
    lines.push("");
  }
  if (flow.edges.length > 0) {
    lines.push("edges:");
    for (const e of flow.edges) {
      lines.push(`  - from: ${e.from}`);
      lines.push(`    to: ${e.to}`);
      if (e.condition) lines.push(`    condition: "${e.condition}"`);
      if (e.label) lines.push(`    label: ${e.label}`);
    }
  }
  return lines.join("\n");
}

/**
 * Minimal YAML parser for flow definitions.
 * Handles the subset of YAML used by Ark flow files.
 */
function parseYaml(text: string): FlowDefinition | null {
  // This is a placeholder -- in production, use a proper YAML parser.
  // For now, try to parse simple key-value YAML.
  try {
    const lines = text.split("\n");
    const flow: FlowDefinition = { name: "", description: "", stages: [], edges: [] };

    let section = "";
    let currentStage: any = null;
    let currentEdge: any = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      if (trimmed.startsWith("name:") && !section) {
        flow.name = trimmed.replace("name:", "").trim().replace(/"/g, "");
      } else if (trimmed.startsWith("description:") && !section) {
        flow.description = trimmed.replace("description:", "").trim().replace(/"/g, "");
      } else if (trimmed === "stages:") {
        section = "stages";
      } else if (trimmed === "edges:") {
        if (currentStage) {
          flow.stages.push(currentStage);
          currentStage = null;
        }
        section = "edges";
      } else if (section === "stages") {
        if (trimmed.startsWith("- name:")) {
          if (currentStage) flow.stages.push(currentStage);
          currentStage = {
            name: trimmed.replace("- name:", "").trim(),
            agent: null,
            action: null,
            type: null,
            gate: "auto",
            task: null,
            depends_on: [],
            on_failure: null,
            verify: [],
            optional: false,
          };
        } else if (currentStage) {
          if (trimmed.startsWith("agent:")) currentStage.agent = trimmed.replace("agent:", "").trim();
          else if (trimmed.startsWith("action:")) currentStage.action = trimmed.replace("action:", "").trim();
          else if (trimmed.startsWith("gate:")) currentStage.gate = trimmed.replace("gate:", "").trim();
          else if (trimmed.startsWith("on_failure:"))
            currentStage.on_failure = trimmed.replace("on_failure:", "").trim().replace(/"/g, "");
        }
      } else if (section === "edges") {
        if (trimmed.startsWith("- from:")) {
          if (currentEdge) flow.edges.push(currentEdge);
          currentEdge = {
            from: trimmed.replace("- from:", "").trim(),
            to: "",
            condition: null,
            label: null,
          };
        } else if (currentEdge) {
          if (trimmed.startsWith("to:")) currentEdge.to = trimmed.replace("to:", "").trim();
          else if (trimmed.startsWith("condition:"))
            currentEdge.condition = trimmed.replace("condition:", "").trim().replace(/"/g, "");
          else if (trimmed.startsWith("label:")) currentEdge.label = trimmed.replace("label:", "").trim();
        }
      }
    }
    if (currentStage) flow.stages.push(currentStage);
    if (currentEdge) flow.edges.push(currentEdge);

    return flow.name ? flow : null;
  } catch {
    return null;
  }
}

export const FlowToolbar = memo(FlowToolbarComponent);
