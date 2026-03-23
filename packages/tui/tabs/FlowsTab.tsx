import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { SplitPane } from "../components/SplitPane.js";
import { SectionHeader } from "../components/SectionHeader.js";
import type { StoreData } from "../hooks/useStore.js";

interface FlowsTabProps extends StoreData {
  pane: "left" | "right";
}

export function FlowsTab({ flows, pane }: FlowsTabProps) {
  const [sel, setSel] = useState(0);

  useInput((input, key) => {
    if (pane === "right") return;
    if (input === "j" || key.downArrow) {
      setSel((s) => Math.min(s + 1, flows.length - 1));
    } else if (input === "k" || key.upArrow) {
      setSel((s) => Math.max(s - 1, 0));
    } else if (input === "g") {
      setSel(0);
    } else if (input === "G") {
      setSel(Math.max(0, flows.length - 1));
    }
  });

  const selected = flows[sel] ?? null;

  return (
    <SplitPane
      focus={pane}
      leftTitle="Flows"
      rightTitle="Details"
      left={<FlowsList flows={flows} sel={sel} />}
      right={<FlowDetail flow={selected} />}
    />
  );
}

// ── List ────────────────────────────────────────────────────────────────────

interface FlowsListProps {
  flows: ReturnType<typeof core.listFlows>;
  sel: number;
}

function FlowsList({ flows, sel }: FlowsListProps) {
  if (flows.length === 0) {
    return <Text dimColor>{"  No flows found."}</Text>;
  }

  return (
    <Box flexDirection="column">
      {flows.map((p, i) => {
        const isSel = i === sel;
        const marker = isSel ? ">" : " ";
        const source = p.source === "user" ? "*" : " ";
        const content = `${marker} ${source} ${p.name.padEnd(16)} ${p.stages.length} stages`;
        return isSel ? (
          <Text key={p.name} bold inverse>{` ${content}`.padEnd(200)}</Text>
        ) : (
          <Text key={p.name}>{` ${content}`}</Text>
        );
      })}
    </Box>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

interface FlowDetailProps {
  flow: ReturnType<typeof core.listFlows>[number] | null;
}

function FlowDetail({ flow }: FlowDetailProps) {
  if (!flow) {
    return <Text dimColor>{"  No flow selected"}</Text>;
  }

  const p = core.loadFlow(flow.name);
  if (!p) {
    return <Text dimColor>{"  Failed to load flow"}</Text>;
  }

  return (
    <Box flexDirection="column">
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
    </Box>
  );
}
