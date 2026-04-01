import React, { useMemo } from "react";
import { Box, Text } from "ink";
import * as core from "../../core/index.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import type { StoreData } from "../hooks/useStore.js";

interface FlowsTabProps extends StoreData {
  pane: "left" | "right";
}

export function FlowsTab({ flows, pane }: FlowsTabProps) {
  const { sel } = useListNavigation(flows.length, { active: pane === "left" });

  const selected = flows[sel] ?? null;

  return (
    <SplitPane
      focus={pane}
      leftTitle="Flows"
      rightTitle="Details"
      left={
        <TreeList
          items={flows}
          renderRow={(p) => {
            const source = p.source === "user" ? "*" : " ";
            return `${source} ${p.name.padEnd(16)} ${p.stages.length} stages`;
          }}
          sel={sel}
          emptyMessage="  No flows found."
        />
      }
      right={<FlowDetail flow={selected} pane={pane} />}
    />
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

interface FlowDetailProps {
  flow: ReturnType<typeof core.listFlows>[number] | null;
  pane: "left" | "right";
}

function FlowDetail({ flow, pane }: FlowDetailProps) {
  if (!flow) {
    return <Box flexGrow={1}><Text dimColor>{"  No flow selected."}</Text></Box>;
  }

  const p = useMemo(() => {
    try { return core.loadFlow(flow.name); } catch { return null; }
  }, [flow.name]);
  if (!p) {
    return <Text dimColor>{"  Failed to load flow"}</Text>;
  }

  return (
    <DetailPanel active={pane === "right"}>
      <Text bold>{` ${p.name}`}</Text>
      {p.description && <Text dimColor>{` ${p.description}`}</Text>}

      <Text> </Text>
      <SectionHeader title="Stages" />
      {p.stages.map((s, i) => {
        const type = s.type ?? (s.action ? "action" : "agent");
        const detail = s.agent ?? s.action ?? "";
        const opt = s.optional ? " (optional)" : "";
        return (
          <Text key={s.name}>
            {"  "}{`${i + 1}. ${s.name.padEnd(14)} `}
            <Text color="cyan">{`[${type}:${detail}]`}</Text>
            {` gate=${s.gate}`}
            {opt && <Text dimColor>{opt}</Text>}
          </Text>
        );
      })}
    </DetailPanel>
  );
}
