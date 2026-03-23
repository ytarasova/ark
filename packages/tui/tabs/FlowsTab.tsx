import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { SplitPane } from "../components/SplitPane.js";
import { SectionHeader } from "../components/SectionHeader.js";
import type { StoreData } from "../hooks/useStore.js";

interface PipelinesTabProps extends StoreData {}

export function PipelinesTab({ pipelines }: PipelinesTabProps) {
  const [sel, setSel] = useState(0);

  useInput((input, key) => {
    if (input === "j" || key.downArrow) {
      setSel((s) => Math.min(s + 1, pipelines.length - 1));
    } else if (input === "k" || key.upArrow) {
      setSel((s) => Math.max(s - 1, 0));
    } else if (input === "g") {
      setSel(0);
    } else if (input === "G") {
      setSel(Math.max(0, pipelines.length - 1));
    }
  });

  const selected = pipelines[sel] ?? null;

  return (
    <SplitPane
      left={<PipelinesList pipelines={pipelines} sel={sel} />}
      right={<PipelineDetail pipeline={selected} />}
    />
  );
}

// ── List ────────────────────────────────────────────────────────────────────

interface PipelinesListProps {
  pipelines: ReturnType<typeof core.listPipelines>;
  sel: number;
}

function PipelinesList({ pipelines, sel }: PipelinesListProps) {
  if (pipelines.length === 0) {
    return <Text dimColor>{"  No pipelines found."}</Text>;
  }

  return (
    <Box flexDirection="column">
      {pipelines.map((p, i) => {
        const isSel = i === sel;
        const marker = isSel ? ">" : " ";
        const source = p.source === "user" ? "*" : " ";
        const content = `${marker} ${source} ${p.name.padEnd(16)} ${p.stages.length} stages`;
        return isSel ? (
          <Text key={p.name} bold inverse>{` ${content} `}</Text>
        ) : (
          <Text key={p.name}>{` ${content}`}</Text>
        );
      })}
    </Box>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

interface PipelineDetailProps {
  pipeline: ReturnType<typeof core.listPipelines>[number] | null;
}

function PipelineDetail({ pipeline }: PipelineDetailProps) {
  if (!pipeline) {
    return <Text dimColor>{"  No pipeline selected"}</Text>;
  }

  // Load full pipeline definition for stage detail
  const p = core.loadPipeline(pipeline.name);
  if (!p) {
    return <Text dimColor>{"  Failed to load pipeline"}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold>{` ${p.name}`}</Text>
      {p.description && <Text dimColor>{` ${p.description}`}</Text>}

      <Text>{""}</Text>
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
