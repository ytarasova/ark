import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import { getApp } from "../../core/app.js";
import type { FlowDefinition, StageDefinition } from "../../core/index.js";
import { useFormNavigation } from "../components/form/useFormNavigation.js";
import { FormTextField } from "../components/form/FormTextField.js";
import { FormSelectField } from "../components/form/FormSelectField.js";
import { submitForm } from "./submitForm.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface FlowFormProps {
  onDone: () => void;
  asyncState: AsyncState;
  projectRoot?: string;
}

const _GATE_CHOICES = [
  { label: "auto", value: "auto" },
  { label: "manual", value: "manual" },
  { label: "condition", value: "condition" },
  { label: "review", value: "review" },
];

const SCOPE_CHOICES = [
  { label: "global", value: "global" },
  { label: "project", value: "project" },
];

export function FlowForm({ onDone, asyncState, projectRoot }: FlowFormProps) {
  const theme = getTheme();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"global" | "project">(projectRoot ? "project" : "global");

  // Stages -- managed separately from the form navigation
  const [stages, setStages] = useState<{ name: string; agent: string; gate: string }[]>([
    { name: "", agent: "", gate: "auto" },
  ]);
  const [stageCursor, setStageCursor] = useState(0);
  const [stageField, setStageField] = useState<"name" | "agent" | "gate">("name");

  const agents = React.useMemo(() => {
    try { return getApp().agents.list(projectRoot).map(a => a.name); } catch { return []; }
  }, [projectRoot]);

  const _agentChoices = React.useMemo(() => [
    { label: "(none)", value: "" },
    ...agents.map(a => ({ label: a, value: a })),
  ], [agents]);

  const submitRef = React.useRef<() => void>(() => {});

  const { active, advance, setEditing } = useFormNavigation({
    fields: [
      { name: "name", type: "text" },
      { name: "description", type: "text" },
      { name: "stages", type: "text" },
      { name: "scope", type: "select" },
    ],
    onCancel: onDone,
    onSubmit: () => submitRef.current(),
  });

  submitRef.current = () => {
    if (!name.trim()) return;
    const validStages = stages.filter(s => s.name.trim());
    if (validStages.length === 0) return;

    const flowDef: FlowDefinition = {
      name: name.trim(),
      description: description.trim() || undefined,
      stages: validStages.map(s => ({
        name: s.name.trim(),
        agent: s.agent || undefined,
        gate: (s.gate || "auto") as StageDefinition["gate"],
      })),
    };

    submitForm({
      create: () => {
        getApp().flows.save(flowDef.name, flowDef, scope);
      },
      onDone,
      asyncState,
      confirmLabel: "Flow created",
    });
  };

  // Stage editing input handler
  useInput((input, key) => {
    if (active !== "stages") return;

    // Add new stage
    if (input === "a" && !key.ctrl) {
      setStages(prev => [...prev, { name: "", agent: "", gate: "auto" }]);
      setStageCursor(stages.length);
      setStageField("name");
      setEditing(true);
      return;
    }

    // Delete current stage (d key when not editing name)
    if (input === "d" && stageField !== "name" && stages.length > 1) {
      setStages(prev => prev.filter((_, i) => i !== stageCursor));
      setStageCursor(Math.max(0, stageCursor - 1));
      return;
    }

    // Navigate stages with j/k
    if (input === "j" && stageCursor < stages.length - 1) {
      setStageCursor(stageCursor + 1);
      return;
    }
    if (input === "k" && stageCursor > 0) {
      setStageCursor(stageCursor - 1);
      return;
    }

    // Cycle fields within stage with left/right
    if (key.leftArrow) {
      setStageField(f => f === "gate" ? "agent" : f === "agent" ? "name" : "name");
      return;
    }
    if (key.rightArrow) {
      setStageField(f => f === "name" ? "agent" : f === "agent" ? "gate" : "gate");
      return;
    }

    // Enter to edit current stage field
    if (key.return && stageField === "name") {
      setEditing(true);
      return;
    }

    // Cycle agent with space
    if (input === " " && stageField === "agent") {
      const currentAgent = stages[stageCursor]?.agent ?? "";
      const idx = agents.indexOf(currentAgent);
      const nextAgent = agents[(idx + 1) % agents.length] ?? "";
      setStages(prev => prev.map((s, i) => i === stageCursor ? { ...s, agent: nextAgent } : s));
      return;
    }

    // Cycle gate with space
    if (input === " " && stageField === "gate") {
      const gates = ["auto", "manual", "condition", "review"];
      const currentGate = stages[stageCursor]?.gate ?? "auto";
      const idx = gates.indexOf(currentGate);
      const nextGate = gates[(idx + 1) % gates.length];
      setStages(prev => prev.map((s, i) => i === stageCursor ? { ...s, gate: nextGate } : s));
      return;
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <Text bold color={theme.accent}>New Flow</Text>
      <Text> </Text>

      <FormTextField
        label="Name"
        value={name}
        onChange={setName}
        active={active === "name"}
        onEditChange={setEditing}
        placeholder="my-flow"
      />

      <FormTextField
        label="Desc"
        value={description}
        onChange={setDescription}
        active={active === "description"}
        onEditChange={setEditing}
        placeholder="What this flow does"
      />

      {/* Stages list */}
      <Box>
        <Text color={active === "stages" ? theme.highlight : "gray"}>
          {active === "stages" ? "> " : "  "}
        </Text>
        <Text color={active === "stages" ? "white" : "gray"} bold={active === "stages"}>
          {"Stages    "}
        </Text>
        {active === "stages" ? (
          <Box flexDirection="column">
            {stages.map((s, i) => {
              const isCurrent = i === stageCursor;
              return (
                <Text key={i}>
                  <Text color={isCurrent ? theme.highlight : "white"}>
                    {isCurrent ? "> " : "  "}
                    {`${(i + 1)}. `}
                  </Text>
                  <Text color={isCurrent && stageField === "name" ? "yellow" : "white"} underline={isCurrent && stageField === "name"}>
                    {s.name || "(name)"}
                  </Text>
                  <Text>{" | "}</Text>
                  <Text color={isCurrent && stageField === "agent" ? "yellow" : "white"} underline={isCurrent && stageField === "agent"}>
                    {s.agent || "(agent)"}
                  </Text>
                  <Text>{" | "}</Text>
                  <Text color={isCurrent && stageField === "gate" ? "yellow" : "white"} underline={isCurrent && stageField === "gate"}>
                    {s.gate}
                  </Text>
                </Text>
              );
            })}
            <Text dimColor>{"  j/k:nav  arrows:field  Space:cycle  a:add  d:del"}</Text>
          </Box>
        ) : (
          <Text>{stages.filter(s => s.name).map(s => s.name).join(", ") || "(none)"}</Text>
        )}
      </Box>

      <FormSelectField
        label="Scope"
        value={scope}
        items={projectRoot ? SCOPE_CHOICES : [{ label: "global", value: "global" }]}
        onSelect={(v) => { setScope(v as "global" | "project"); advance(); }}
        active={active === "scope"}
        displayValue={scope}
      />
    </Box>
  );
}
