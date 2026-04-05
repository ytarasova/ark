import React, { useMemo, useState, useEffect } from "react";
import { Box, Text } from "ink";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useArkClient } from "../hooks/useArkClient.js";
import type { StoreData } from "../hooks/useArkStore.js";

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
  flow: any | null;
  pane: "left" | "right";
}

function FlowDetail({ flow, pane }: FlowDetailProps) {
  const ark = useArkClient();
  const [p, setP] = useState<any>(null);

  useEffect(() => {
    if (!flow) { setP(null); return; }
    ark.flowRead(flow.name).then(setP).catch(() => setP(null));
  }, [flow?.name]);

  if (!flow) {
    return <Box flexGrow={1}><Text dimColor>{"  No flow selected."}</Text></Box>;
  }

  if (!p) {
    return <Text dimColor>{"  Loading..."}</Text>;
  }

  return (
    <DetailPanel active={pane === "right"}>
      <Text bold>{` ${p.name}`}</Text>
      {p.description && <Text dimColor>{` ${p.description}`}</Text>}

      <Text> </Text>
      <SectionHeader title="Stages" />
      {p.stages.map((s: any, i: number) => {
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
