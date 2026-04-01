import React, { useMemo, useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useFocus } from "../hooks/useFocus.js";
import { AgentForm } from "../forms/AgentForm.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface AgentsTabProps extends StoreData {
  pane: "left" | "right";
  asyncState: AsyncState;
  refresh: () => void;
}

export function AgentsTab({ agents, pane, asyncState, refresh }: AgentsTabProps) {
  const focus = useFocus();
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const hasOverlay = formMode !== null;
  const { sel } = useListNavigation(agents.length, { active: pane === "left" && !hasOverlay });
  const status = useStatusMessage();
  const projectRoot = useMemo(() => core.findProjectRoot(process.cwd()) ?? undefined, []);

  const selected = agents[sel] ?? null;

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

    if (input === "e") {
      if (selected._source === "builtin") {
        status.show("Cannot edit builtin -- press 'c' to copy first");
        return;
      }
      setFormMode("edit");
      return;
    }

    if (input === "c") {
      const copyName = `${selected.name}-copy`;
      const scope = projectRoot ? "project" : "global";
      asyncState.run("Copying agent...", async () => {
        core.saveAgent({ ...selected, name: copyName } as core.AgentDefinition, scope, scope === "project" ? projectRoot : undefined);
        status.show(`Copied -> '${copyName}' (${scope})`);
        refresh();
      });
      return;
    }

    if (input === "x") {
      if (selected._source === "builtin") {
        status.show("Cannot delete builtin agents");
        return;
      }
      const scope = selected._source as "project" | "global";
      asyncState.run("Deleting agent...", async () => {
        core.deleteAgent(selected.name, scope, scope === "project" ? projectRoot : undefined);
        status.show(`Deleted '${selected.name}'`);
        refresh();
      });
      return;
    }
  });

  return (
    <SplitPane
      focus={pane}
      leftTitle="Agents"
      rightTitle={formMode ? (formMode === "create" ? "New Agent" : "Edit Agent") : "Details"}
      left={
        <TreeList
          items={agents}
          renderRow={(a, isSelected) => {
            const marker = isSelected ? ">" : " ";
            return `${marker} ${a.name.padEnd(18)} ${a.model.padEnd(8)} ${a.description}`;
          }}
          sel={sel}
          emptyMessage="No agents found."
        />
      }
      right={
        formMode ? (
          <AgentForm
            agent={formMode === "edit" ? selected : null}
            onDone={closeForm}
            asyncState={asyncState}
            projectRoot={projectRoot}
          />
        ) : (
          <AgentDetail agent={selected} pane={pane} statusMessage={status.message} projectRoot={projectRoot} />
        )
      }
    />
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

function AgentDetail({ agent, pane, statusMessage, projectRoot }: {
  agent: core.AgentDefinition | null;
  pane: "left" | "right";
  statusMessage: string | null;
  projectRoot?: string;
}) {
  if (!agent) {
    return <Box flexGrow={1}><Text dimColor>{"  No agent selected"}</Text></Box>;
  }

  const a = useMemo(() => {
    try { return core.loadAgent(agent.name, projectRoot); } catch { return null; }
  }, [agent.name, projectRoot]);
  if (!a) return <Text dimColor>{"  Failed to load agent"}</Text>;

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
      {statusMessage && <Text color="yellow">{` ${statusMessage}`}</Text>}

      <Text> </Text>
      <SectionHeader title="Config" />
      <Text>{`  Source:     ${a._source}`}</Text>
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
