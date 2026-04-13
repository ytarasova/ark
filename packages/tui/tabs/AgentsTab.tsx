import React, { useMemo, useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import { findProjectRoot } from "../../core/index.js";
import type { AgentDefinition } from "../../core/index.js";
import type { RuntimeDefinition } from "../../types/index.js";
import { KeyHint, sep, NAV_HINTS, GLOBAL_HINTS } from "../helpers/statusBarHints.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useFocus } from "../hooks/useFocus.js";
import { useArkClient } from "../hooks/useArkClient.js";
import { AgentForm } from "../forms/AgentForm.js";
import type { StoreData } from "../hooks/useArkStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

// ── Unified list item ──────────────────────────────────────────────────────

type ListItem =
  | { kind: "role"; data: AgentDefinition }
  | { kind: "runtime"; data: RuntimeDefinition };

function groupLabel(item: ListItem): string {
  return item.kind === "role" ? "Roles" : "Runtimes";
}

interface AgentsTabProps extends StoreData {
  pane: "left" | "right";
  asyncState: AsyncState;
  refresh: () => void;
}

export function AgentsTab({ agents, pane, asyncState, refresh }: AgentsTabProps) {
  const focus = useFocus();
  const ark = useArkClient();
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const hasOverlay = formMode !== null;
  const status = useStatusMessage();
  const projectRoot = useMemo(() => findProjectRoot(process.cwd()) ?? undefined, []);

  // Fetch runtimes
  const [runtimes, setRuntimes] = useState<RuntimeDefinition[]>([]);
  useEffect(() => {
    ark.runtimeList().then(setRuntimes).catch(() => setRuntimes([]));
  }, [ark]);

  // Build combined list: roles and runtimes (no pre-sort needed -- TreeList handles grouping)
  const items: ListItem[] = useMemo(() => {
    const roles: ListItem[] = agents.map((a) => ({ kind: "role" as const, data: a }));
    const rts: ListItem[] = runtimes.map((r) => ({ kind: "runtime" as const, data: r }));
    return [...roles, ...rts];
  }, [agents, runtimes]);

  const [selected, setSelected] = useState<ListItem | null>(null);

  useEffect(() => {
    if (formMode) focus.push("form");
    else focus.pop("form");
  }, [formMode]);

  const closeForm = useCallback(() => {
    setFormMode(null);
    refresh();
  }, [refresh]);

  useInput((input, _key) => {
    if (hasOverlay || pane !== "left") return;

    if (input === "n") { setFormMode("create"); return; }

    if (!selected) return;

    // Only roles support edit/copy/delete
    if (selected.kind !== "role") {
      if (input === "e" || input === "c" || input === "x") {
        status.show("Only agent roles can be edited/copied/deleted");
        return;
      }
      return;
    }

    const agent = selected.data as AgentDefinition;

    if (input === "e") {
      if (agent._source === "builtin") {
        status.show("Cannot edit builtin -- press 'c' to copy first");
        return;
      }
      setFormMode("edit");
      return;
    }

    if (input === "c") {
      const copyName = `${agent.name}-copy`;
      const scope = projectRoot ? "project" : "global";
      asyncState.run("Copying agent...", async () => {
        await ark.agentSave({ ...agent, name: copyName }, { scope });
        status.show(`Copied -> '${copyName}' (${scope})`);
        refresh();
      });
      return;
    }

    if (input === "x") {
      if (agent._source === "builtin") {
        status.show("Cannot delete builtin agents");
        return;
      }
      const scope = agent._source as "project" | "global";
      asyncState.run("Deleting agent...", async () => {
        await ark.agentDelete(agent.name, scope);
        status.show(`Deleted '${agent.name}'`);
        refresh();
      });
      return;
    }
  });

  // Selected agent for form editing (only if it's a role)
  const selectedAgent = selected?.kind === "role" ? (selected.data as AgentDefinition) : null;

  return (
    <SplitPane
      focus={pane}
      leftTitle="Agents"
      rightTitle={formMode ? (formMode === "create" ? "New Agent" : "Edit Agent") : "Details"}
      left={
        <TreeList
          items={items}
          getKey={(i) => `${i.kind}:${i.data.name}`}
          groupBy={groupLabel}
          emptyGroups={["Roles", "Runtimes"]}
          renderRow={(item) => {
            if (item.kind === "role") {
              const a = item.data as AgentDefinition;
              const rt = (a.runtime ?? "claude").padEnd(12);
              return `${a.name.padEnd(18)} ${rt} ${a.model.padEnd(8)} ${a.description}`;
            } else {
              const r = item.data as RuntimeDefinition;
              const type = (r.type ?? "").padEnd(12);
              const model = (r.default_model ?? "").padEnd(8);
              return `${r.name.padEnd(18)} ${type} ${model} ${r.description ?? ""}`;
            }
          }}
          selectedKey={selected ? `${selected.kind}:${selected.data.name}` : null}
          onSelect={(item) => setSelected(item)}
          active={pane === "left" && !hasOverlay}
          emptyMessage="  No agents or runtimes found."
        />
      }
      right={
        formMode ? (
          <AgentForm
            agent={formMode === "edit" ? selectedAgent : null}
            onDone={closeForm}
            asyncState={asyncState}
            projectRoot={projectRoot}
          />
        ) : selected?.kind === "role" ? (
          <AgentDetail agent={selected.data as AgentDefinition} pane={pane} statusMessage={status.message} projectRoot={projectRoot} />
        ) : selected?.kind === "runtime" ? (
          <RuntimeDetail runtime={selected.data as RuntimeDefinition} pane={pane} statusMessage={status.message} />
        ) : (
          <Box flexGrow={1}><Text dimColor>{"  No item selected."}</Text></Box>
        )
      }
    />
  );
}

// ── Agent Detail ───────────────────────────────────────────────────────────

function AgentDetail({ agent, pane, statusMessage, projectRoot }: {
  agent: AgentDefinition | null;
  pane: "left" | "right";
  statusMessage: string | null;
  projectRoot?: string;
}) {
  const theme = getTheme();
  const ark = useArkClient();
  if (!agent) {
    return <Box flexGrow={1}><Text dimColor>{"  No agent selected."}</Text></Box>;
  }

  const [a, setA] = useState<AgentDefinition | null>(null);
  useEffect(() => {
    ark.agentRead(agent.name).then(setA).catch(() => setA(null));
  }, [agent.name, projectRoot]);
  if (!a) return <Text dimColor>{"  Loading..."}</Text>;

  const sections: [string, string[]][] = [
    ["Tools", a.tools],
    ["MCP Servers", a.mcp_servers.map(String)],
    ["Skills", a.skills],
    ["Memories", a.memories],
    ["Context", a.context],
  ];

  return (
    <DetailPanel active={pane === "right"}>
      <Text bold>{` ${a.name}`}</Text>
      {a.description && <Text dimColor>{` ${a.description}`}</Text>}
      {statusMessage && <Text color={theme.waiting}>{` ${statusMessage}`}</Text>}

      <Text> </Text>
      <SectionHeader title="Config" />
      <Text>{`  Source:     ${a._source}`}</Text>
      <Text>{`  Runtime:    ${a.runtime ?? "claude"}`}</Text>
      <Text>{`  Model:      ${a.model}`}</Text>
      <Text>{`  Max turns:  ${a.max_turns}`}</Text>
      <Text>{`  Permission: ${a.permission_mode}`}</Text>

      {sections.map(([title, items]) => (
        <React.Fragment key={title}>
          <Text> </Text>
          <SectionHeader title={`${title} (${items.length})`} />
          {items.length > 0 ? (
            items.map((item, i) => <Text key={i}>{`  * ${item}`}</Text>)
          ) : (
            <Text dimColor>{"  (none)"}</Text>
          )}
        </React.Fragment>
      ))}

      {a.system_prompt && (
        <>
          <Text> </Text>
          <SectionHeader title="System Prompt" />
          {a.system_prompt.split("\n").map((line, i) => (
            <Text key={i} dimColor>{`  ${line}`}</Text>
          ))}
        </>
      )}
    </DetailPanel>
  );
}

// ── Runtime Detail ─────────────────────────────────────────────────────────

function RuntimeDetail({ runtime, pane, statusMessage }: {
  runtime: RuntimeDefinition;
  pane: "left" | "right";
  statusMessage: string | null;
}) {
  const theme = getTheme();
  const ark = useArkClient();

  // Fetch full runtime details
  const [detail, setDetail] = useState<RuntimeDefinition | null>(null);
  useEffect(() => {
    ark.runtimeRead(runtime.name).then(setDetail).catch(() => setDetail(null));
  }, [runtime.name]);

  const r = detail ?? runtime;

  return (
    <DetailPanel active={pane === "right"}>
      <Text bold>{` ${r.name}`}</Text>
      {r.description && <Text dimColor>{` ${r.description}`}</Text>}
      {statusMessage && <Text color={theme.waiting}>{` ${statusMessage}`}</Text>}

      <Text> </Text>
      <SectionHeader title="Config" />
      <Text>{`  Source:         ${r._source ?? "builtin"}`}</Text>
      <Text>{`  Type:           ${r.type}`}</Text>
      <Text>{`  Default model:  ${r.default_model ?? "-"}`}</Text>
      {r.permission_mode && <Text>{`  Permission:     ${r.permission_mode}`}</Text>}
      {r.task_delivery && <Text>{`  Task delivery:  ${r.task_delivery}`}</Text>}

      {r.command && r.command.length > 0 && (
        <>
          <Text> </Text>
          <SectionHeader title="Command" />
          <Text>{`  ${r.command.join(" ")}`}</Text>
        </>
      )}

      {r.models && r.models.length > 0 && (
        <>
          <Text> </Text>
          <SectionHeader title={`Models (${r.models.length})`} />
          {r.models.map((m, i) => (
            <Text key={i}>{`  ${m.id.padEnd(12)} ${m.label}`}</Text>
          ))}
        </>
      )}

      {r.env && Object.keys(r.env).length > 0 && (
        <>
          <Text> </Text>
          <SectionHeader title="Environment" />
          {Object.entries(r.env).map(([k, v]) => (
            <Text key={k}>{`  ${k}=${v}`}</Text>
          ))}
        </>
      )}
    </DetailPanel>
  );
}

export function getAgentsHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS, sep(0),
    <KeyHint key="n" k="n" label="new" />,
    <KeyHint key="e" k="e" label="edit" />,
    <KeyHint key="c" k="c" label="copy" />,
    <KeyHint key="x" k="x" label="delete" />,
    ...GLOBAL_HINTS,
  ];
}
