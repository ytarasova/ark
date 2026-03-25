import React, { useMemo } from "react";
import { Text } from "ink";
import * as core from "../../core/index.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import type { StoreData } from "../hooks/useStore.js";

interface AgentsTabProps extends StoreData {
  pane: "left" | "right";
}

export function AgentsTab({ agents, pane }: AgentsTabProps) {
  const { sel } = useListNavigation(agents.length, { active: pane === "left" });

  const selected = agents[sel] ?? null;

  return (
    <SplitPane
      focus={pane}
      leftTitle="Agents"
      rightTitle="Details"
      left={
        <TreeList
          items={agents}
          renderRow={(a) => {
            const marker = agents.indexOf(a) === sel ? ">" : " ";
            const source = a._source === "user" ? "*" : " ";
            return `${marker} ${source} ${a.name.padEnd(16)} ${a.model}`;
          }}
          sel={sel}
          emptyMessage="No agents found."
        />
      }
      right={<AgentDetail agent={selected} pane={pane} />}
    />
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

interface AgentDetailProps {
  agent: ReturnType<typeof core.listAgents>[number] | null;
  pane: "left" | "right";
}

function AgentDetail({ agent, pane }: AgentDetailProps) {
  if (!agent) {
    return <Box flexGrow={1}><Text dimColor>{"  No agent selected"}</Text></Box>;
  }

  // Load full agent definition for detail view
  const a = useMemo(() => {
    try { return core.loadAgent(agent.name); } catch { return null; }
  }, [agent.name]);
  if (!a) {
    return <Text dimColor>{"  Failed to load agent"}</Text>;
  }

  const sections: [string, string[]][] = [
    ["Tools", a.tools],
    ["MCP Servers", a.mcp_servers.map(String)],
    ["Skills", a.skills],
    ["Memories", a.memories],
    ["Context", a.context],
  ];

  return (
    <DetailPanel active={pane === "right"}>
      <Text bold>{` ${a.name}`}<Text dimColor>{` (${a._source})`}</Text></Text>
      {a.description && <Text dimColor>{` ${a.description}`}</Text>}

      <Text> </Text>
      <SectionHeader title="Config" />
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
