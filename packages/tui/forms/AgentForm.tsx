import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { useFormNavigation } from "../components/form/useFormNavigation.js";
import { FormTextField } from "../components/form/FormTextField.js";
import { FormSelectField } from "../components/form/FormSelectField.js";
import { submitForm } from "./submitForm.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface AgentFormProps {
  agent?: core.AgentDefinition | null;
  onDone: () => void;
  asyncState: AsyncState;
  projectRoot?: string;
}

const MODEL_CHOICES = [
  { label: "opus", value: "opus" },
  { label: "sonnet", value: "sonnet" },
  { label: "haiku", value: "haiku" },
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
  const isEdit = !!agent;

  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [model, setModel] = useState(agent?.model ?? "sonnet");
  const [maxTurns, setMaxTurns] = useState(String(agent?.max_turns ?? 200));
  const [tools, setTools] = useState<string[]>(agent?.tools ?? ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
  const [permissionMode, setPermissionMode] = useState(agent?.permission_mode ?? "bypassPermissions");
  const [scope, setScope] = useState<"project" | "global">(
    agent?._source === "global" ? "global" : projectRoot ? "project" : "global",
  );
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt ?? "");

  const submit = useCallback(() => {
    if (!isEdit && !name.trim()) return;

    const agentDef: Omit<core.AgentDefinition, "_source" | "_path"> = {
      name: isEdit ? agent!.name : name.trim(),
      description,
      model,
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
      create: () => {
        core.saveAgent(agentDef as core.AgentDefinition, saveScope, saveScope === "project" ? projectRoot : undefined);
      },
      onDone,
      asyncState,
      confirmLabel: isEdit ? "Agent saved" : "Agent created",
    });
  }, [name, description, model, maxTurns, tools, permissionMode, scope, systemPrompt, isEdit, agent, projectRoot, onDone, asyncState]);

  const { active, advance, setEditing } = useFormNavigation({
    fields: [
      { name: "name", type: "text", visible: !isEdit },
      { name: "description", type: "text" },
      { name: "model", type: "select" },
      { name: "max_turns", type: "text" },
      { name: "tools", type: "text" },
      { name: "permission", type: "select" },
      { name: "scope", type: "select", visible: !isEdit },
      { name: "prompt", type: "text" },
    ],
    onCancel: onDone,
    onSubmit: submit,
  });

  // Tools field: j/k navigate, space toggles
  const [toolCursor, setToolCursor] = useState(0);
  useInput((input, key) => {
    if (active !== "tools") return;
    if (input === "j" || key.downArrow) setToolCursor(c => Math.min(c + 1, TOOL_OPTIONS.length - 1));
    if (input === "k" || key.upArrow) setToolCursor(c => Math.max(c - 1, 0));
    if (input === " " || key.return) {
      const tool = TOOL_OPTIONS[toolCursor];
      setTools(prev => prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]);
    }
  });

  // System prompt field: Enter opens $EDITOR
  useInput((_input, key) => {
    if (active !== "prompt") return;
    if (key.return) {
      setEditing(true);
      try {
        const os = require("os");
        const fs = require("fs");
        const path = require("path");
        const cp = require("child_process");
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-agent-"));
        const tmpFile = path.join(tmpDir, "system-prompt.md");
        fs.writeFileSync(tmpFile, systemPrompt);
        const editor = process.env.EDITOR || "vi";
        cp.execFileSync(editor, [tmpFile], { stdio: "inherit" });
        setSystemPrompt(fs.readFileSync(tmpFile, "utf-8"));
      } catch {}
      setEditing(false);
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <Text bold color="cyan">{isEdit ? `Edit: ${agent!.name}` : "New Agent"}</Text>
      <Text> </Text>

      {!isEdit && (
        <FormTextField label="Name" value={name} onChange={setName} active={active === "name"} onEditChange={setEditing} placeholder="my-agent" />
      )}

      <FormTextField label="Desc" value={description} onChange={setDescription} active={active === "description"} onEditChange={setEditing} placeholder="What this agent does" />

      <FormSelectField label="Model" value={model} items={MODEL_CHOICES} onSelect={(v) => { setModel(v); advance(); }} active={active === "model"} displayValue={model} />

      <FormTextField label="Max turns" value={maxTurns} onChange={setMaxTurns} active={active === "max_turns"} onEditChange={setEditing} />

      {/* Tools checkbox list */}
      <Box>
        <Text color={active === "tools" ? "cyan" : "gray"}>
          {active === "tools" ? "> " : "  "}
        </Text>
        <Text color={active === "tools" ? "white" : "gray"} bold={active === "tools"}>
          {"Tools     "}
        </Text>
        {active === "tools" ? (
          <Box flexDirection="column">
            {TOOL_OPTIONS.map((t, i) => (
              <Text key={t}>
                <Text color={i === toolCursor ? "cyan" : "white"}>
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
        <Text color={active === "prompt" ? "cyan" : "gray"}>
          {active === "prompt" ? "> " : "  "}
        </Text>
        <Text color={active === "prompt" ? "white" : "gray"} bold={active === "prompt"}>
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
