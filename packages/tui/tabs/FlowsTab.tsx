import React, { useMemo, useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import { findProjectRoot } from "../../core/index.js";
import { KeyHint, NAV_HINTS, GLOBAL_HINTS } from "../helpers/statusBarHints.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useFocus } from "../hooks/useFocus.js";
import { useArkClient } from "../hooks/useArkClient.js";
import { FlowForm } from "../forms/FlowForm.js";
import type { StoreData } from "../hooks/useArkStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface FlowsTabProps extends StoreData {
  pane: "left" | "right";
  asyncState: AsyncState;
  refresh: () => void;
}

export function FlowsTab({ flows, pane, asyncState, refresh }: FlowsTabProps) {
  const focus = useFocus();
  const ark = useArkClient();
  const [formMode, setFormMode] = useState<"create" | null>(null);
  const hasOverlay = formMode !== null;
  const [selected, setSelected] = useState<any>(null);
  const status = useStatusMessage();
  const projectRoot = useMemo(() => findProjectRoot(process.cwd()) ?? undefined, []);

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

    if (input === "x") {
      if (selected.source === "builtin") {
        status.show("Cannot delete builtin flows");
        return;
      }
      asyncState.run("Deleting flow...", async () => {
        await ark.flowDelete(selected.name);
        status.show(`Deleted '${selected.name}'`);
        refresh();
      });
      return;
    }
  });

  return (
    <SplitPane
      focus={pane}
      leftTitle="Flows"
      rightTitle={formMode === "create" ? "New Flow" : "Details"}
      left={
        <TreeList
          items={flows}
          getKey={(p) => p.name}
          renderRow={(p) => {
            const source = p.source === "user" ? "*" : " ";
            return `${source} ${p.name.padEnd(16)} ${p.stages.length} stages`;
          }}
          selectedKey={selected?.name ?? null}
          onSelect={(item) => setSelected(item)}
          active={pane === "left" && !hasOverlay}
          emptyMessage="  No flows found."
        />
      }
      right={
        formMode === "create" ? (
          <FlowForm
            onDone={closeForm}
            asyncState={asyncState}
            projectRoot={projectRoot}
          />
        ) : (
          <FlowDetail flow={selected} pane={pane} statusMessage={status.message} />
        )
      }
    />
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

function FlowDetail({ flow, pane, statusMessage }: {
  flow: any | null;
  pane: "left" | "right";
  statusMessage: string | null;
}) {
  const theme = getTheme();
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
      {statusMessage && <Text color={theme.waiting}>{` ${statusMessage}`}</Text>}

      <Text> </Text>
      <SectionHeader title="Stages" />
      {p.stages.map((s: any, i: number) => {
        const type = s.type ?? (s.action ? "action" : "agent");
        const detail = s.agent ?? s.action ?? "";
        const opt = s.optional ? " (optional)" : "";
        return (
          <Text key={s.name}>
            {"  "}{`${i + 1}. ${s.name.padEnd(14)} `}
            <Text color={theme.accent}>{`[${type}:${detail}]`}</Text>
            {` gate=${s.gate}`}
            {opt && <Text dimColor>{opt}</Text>}
          </Text>
        );
      })}
    </DetailPanel>
  );
}

export function getFlowsHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS,
    <KeyHint key="tab" k="Tab" label="detail" />,
    ...GLOBAL_HINTS,
  ];
}
