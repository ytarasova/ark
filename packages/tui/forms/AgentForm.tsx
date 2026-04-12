import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import type { AgentDefinition } from "../../core/index.js";
import { useFormNavigation } from "../components/form/useFormNavigation.js";
import { FormTextField } from "../components/form/FormTextField.js";
import { FormSelectField } from "../components/form/FormSelectField.js";
import { submitForm } from "./submitForm.js";
import { useToolSelection } from "../hooks/useToolSelection.js";
import { useArkClient } from "../hooks/useArkClient.js";
import { openExternalEditor } from "../helpers/openExternalEditor.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface AgentFormProps {
  agent?: AgentDefinition | null;
  onDone: () => void;
  asyncState: AsyncState;
  projectRoot?: string;
}

const MODEL_CHOICES = [
  { label: "opus", value: "opus" },
  { label: "sonnet", value: "sonnet" },
  { label: "haiku", value: "haiku" },
];

const RUNTIME_CHOICES = [
  { label: "claude-code", value: "claude-code" },
  { label: "cli-agent", value: "cli-agent" },
];

const PERMISSION_CHOICES = [
  { label: "bypassPermissions", value: "bypassPermissions" },
  { label: "default", value: "default" },
];

const SCOPE_CHOICES = [
  { label: "project", value: "project" },
  { label: "global", value: "global" },
];

const TOOL_OPTIONS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch"];

export function AgentForm({ agent, onDone, asyncState, projectRoot }: AgentFormProps) {
  const theme = getTheme();
  const ark = useArkClient();
  const isEdit = !!agent;

  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [model, setModel] = useState(agent?.model ?? "sonnet");
  const [maxTurns, setMaxTurns] = useState(String(agent?.max_turns ?? 200));
  const [permissionMode, setPermissionMode] = useState(agent?.permission_mode ?? "bypassPermissions");
  const [scope, setScope] = useState<"project" | "global">(
    agent?._source === "global" ? "global" : projectRoot ? "project" : "global",
  );
  const [runtime, setRuntime] = useState(agent?.runtime ?? "claude-code");
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt ?? "");

  // submit is defined as a ref-stable callback below, after useFormNavigation
  // We use a ref pattern to avoid circular dependency between submit and useFormNavigation
  const submitRef = React.useRef<() => void>(() => {});

  const { active, advance, setEditing } = useFormNavigation({
    fields: [
      { name: "name", type: "text", visible: !isEdit },
      { name: "description", type: "text" },
      { name: "model", type: "select" },
      { name: "runtime", type: "select" },
      { name: "max_turns", type: "text" },
      { name: "tools", type: "text" },
      { name: "permission", type: "select" },
      { name: "scope", type: "select", visible: !isEdit },
      { name: "prompt", type: "text" },
    ],
    onCancel: onDone,
    onSubmit: () => submitRef.current(),
  });

  const { tools, setTools: _setTools, toolCursor } = useToolSelection(
    TOOL_OPTIONS,
    agent?.tools ?? ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    active === "tools",
  );

  submitRef.current = () => {
    if (!isEdit && !name.trim()) return;

    const agentDef: Omit<AgentDefinition, "_source" | "_path"> = {
      name: isEdit ? agent!.name : name.trim(),
      description,
      model,
      runtime,
      max_turns: parseInt(maxTurns) || 200,
      system_prompt: systemPrompt,
      tools,
      mcp_servers: agent?.mcp_servers ?? [],
      skills: agent?.skills ?? [],
      memories: agent?.memories ?? [],
      context: agent?.context ?? [],
      permission_mode: permissionMode,
      env: agent?.env ?? {},
    };

    const saveScope = isEdit ? (agent!._source as "project" | "global") : scope;

    submitForm({
      create: async () => {
        await ark.agentSave(agentDef as AgentDefinition, { scope: saveScope, update: isEdit });
      },
      onDone,
      asyncState,
      confirmLabel: isEdit ? "Agent saved" : "Agent created",
    });
  };

  // System prompt field: Enter opens $EDITOR
  useInput((_input, key) => {
    if (active !== "prompt") return;
    if (key.return) {
      setEditing(true);
      try {
        setSystemPrompt(openExternalEditor(systemPrompt));
      } catch { /* editor may not be available */ }
      setEditing(false);
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <Text bold color={theme.accent}>{isEdit ? `Edit: ${agent!.name}` : "New Agent"}</Text>
      <Text> </Text>

      {!isEdit && (
        <FormTextField label="Name" value={name} onChange={setName} active={active === "name"} onEditChange={setEditing} placeholder="my-agent" />
      )}

      <FormTextField label="Desc" value={description} onChange={setDescription} active={active === "description"} onEditChange={setEditing} placeholder="What this agent does" />

      <FormSelectField label="Model" value={model} items={MODEL_CHOICES} onSelect={(v) => { setModel(v); advance(); }} active={active === "model"} displayValue={model} />

      <FormSelectField label="Runtime" value={runtime} items={RUNTIME_CHOICES} onSelect={(v) => { setRuntime(v); advance(); }} active={active === "runtime"} displayValue={runtime} />

      <FormTextField label="Max turns" value={maxTurns} onChange={setMaxTurns} active={active === "max_turns"} onEditChange={setEditing} />

      {/* Tools checkbox list */}
      <Box>
        <Text color={active === "tools" ? theme.accent : theme.dimText}>
          {active === "tools" ? "> " : "  "}
        </Text>
        <Text color={active === "tools" ? "white" : theme.dimText} bold={active === "tools"}>
          {"Tools     "}
        </Text>
        {active === "tools" ? (
          <Box flexDirection="column">
            {TOOL_OPTIONS.map((t, i) => (
              <Text key={t}>
                <Text color={i === toolCursor ? theme.accent : "white"}>
                  {tools.includes(t) ? "[x] " : "[ ] "}
                  {t}
                </Text>
              </Text>
            ))}
            <Text dimColor>{"  Space:toggle  Tab:next field"}</Text>
          </Box>
        ) : (
          <Text>{tools.join(", ")}</Text>
        )}
      </Box>

      <FormSelectField label="Permission" value={permissionMode} items={PERMISSION_CHOICES} onSelect={(v) => { setPermissionMode(v); advance(); }} active={active === "permission"} displayValue={permissionMode} />

      {!isEdit && (
        <FormSelectField label="Scope" value={scope} items={projectRoot ? SCOPE_CHOICES : [{ label: "global", value: "global" }]} onSelect={(v) => { setScope(v as "project" | "global"); advance(); }} active={active === "scope"} displayValue={scope} />
      )}

      {/* System prompt */}
      <Box>
        <Text color={active === "prompt" ? theme.accent : theme.dimText}>
          {active === "prompt" ? "> " : "  "}
        </Text>
        <Text color={active === "prompt" ? "white" : theme.dimText} bold={active === "prompt"}>
          {"Prompt    "}
        </Text>
        <Text dimColor>
          {systemPrompt
            ? `${systemPrompt.split("\n")[0].slice(0, 50)}... (Enter to edit)`
            : "(empty -- Enter to edit in $EDITOR)"}
        </Text>
      </Box>
    </Box>
  );
}
