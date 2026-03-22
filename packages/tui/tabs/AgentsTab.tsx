import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { SplitPane } from "../components/SplitPane.js";
import { SectionHeader } from "../components/SectionHeader.js";
import type { StoreData } from "../hooks/useStore.js";

interface AgentsTabProps extends StoreData {}

export function AgentsTab({ agents }: AgentsTabProps) {
  const [sel, setSel] = useState(0);

  useInput((input, key) => {
    if (input === "j" || key.downArrow) {
      setSel((s) => Math.min(s + 1, agents.length - 1));
    } else if (input === "k" || key.upArrow) {
      setSel((s) => Math.max(s - 1, 0));
    } else if (input === "g") {
      setSel(0);
    } else if (input === "G") {
      setSel(Math.max(0, agents.length - 1));
    }
  });

  const selected = agents[sel] ?? null;

  return (
    <SplitPane
      left={<AgentsList agents={agents} sel={sel} />}
      right={<AgentDetail agent={selected} />}
    />
  );
}

// ── List ────────────────────────────────────────────────────────────────────

interface AgentsListProps {
  agents: ReturnType<typeof core.listAgents>;
  sel: number;
}

function AgentsList({ agents, sel }: AgentsListProps) {
  if (agents.length === 0) {
    return <Text dimColor>{"  No agents found."}</Text>;
  }

  return (
    <Box flexDirection="column">
      {agents.map((a, i) => {
        const isSel = i === sel;
        const marker = isSel ? ">" : " ";
        const source = a._source === "user" ? "*" : " ";
        const content = `${marker} ${source} ${a.name.padEnd(16)} ${a.model}`;
        return isSel ? (
          <Text key={a.name} bold inverse>{` ${content} `}</Text>
        ) : (
          <Text key={a.name}>{` ${content}`}</Text>
        );
      })}
    </Box>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

interface AgentDetailProps {
  agent: ReturnType<typeof core.listAgents>[number] | null;
}

function AgentDetail({ agent }: AgentDetailProps) {
  if (!agent) {
    return <Text dimColor>{"  No agent selected"}</Text>;
  }

  // Load full agent definition for detail view
  const a = core.loadAgent(agent.name);
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
    <Box flexDirection="column">
      <Text bold>{` ${a.name}`}<Text dimColor>{` (${a._source})`}</Text></Text>
      {a.description && <Text dimColor>{` ${a.description}`}</Text>}

      <Text>{""}</Text>
      <SectionHeader title="Config" />
      <Text>{`  Model:      ${a.model}`}</Text>
      <Text>{`  Max turns:  ${a.max_turns}`}</Text>
      <Text>{`  Permission: ${a.permission_mode}`}</Text>

      {sections.map(([title, items]) => (
        <React.Fragment key={title}>
          <Text>{""}</Text>
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
          <Text>{""}</Text>
          <SectionHeader title="System Prompt" />
          {a.system_prompt.split("\n").slice(0, 6).map((line, i) => (
            <Text key={i} dimColor>{`  ${line}`}</Text>
          ))}
        </>
      )}
    </Box>
  );
}
