import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import type { Schedule } from "../../types/index.js";
import { useArkClient } from "../hooks/useArkClient.js";
import { useAsync } from "../hooks/useAsync.js";
import { KeyHint, sep, NAV_HINTS, GLOBAL_HINTS } from "../helpers/statusBarHints.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useConfirmation } from "../hooks/useConfirmation.js";
import { useFocus } from "../hooks/useFocus.js";
import { SplitPane } from "../components/SplitPane.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { KeyValue } from "../components/KeyValue.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import {
  FormTextField,
  FormSelectField,
  useFormNavigation,
} from "../components/form/index.js";

interface SchedulesTabProps {
  pane: "left" | "right";
}

export function SchedulesTab({ pane }: SchedulesTabProps) {
  const theme = getTheme();
  const ark = useArkClient();
  const asyncState = useAsync();
  const confirmation = useConfirmation();
  const focus = useFocus();
  const status = useStatusMessage();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  // Load schedules on mount and periodically
  useEffect(() => {
    const load = () => {
      ark.scheduleList().then(setSchedules).catch(() => {});
    };
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Push/pop focus when confirmation is pending or create form is open
  useEffect(() => {
    if (confirmation.pending) focus.push("confirm");
    else focus.pop("confirm");
  }, [confirmation.pending]);

  useEffect(() => {
    if (showCreate) focus.push("schedule-create");
    else focus.pop("schedule-create");
  }, [showCreate]);

  const sorted = useMemo(() =>
    [...schedules].sort((a, b) => {
      // Enabled first, then by created_at descending
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    }),
  [schedules]);

  const { sel } = useListNavigation(sorted.length, { active: pane === "left" && !confirmation.pending && !showCreate });
  const selected = sorted[sel] ?? null;

  const refresh = () => {
    ark.scheduleList().then(setSchedules).catch(() => {});
  };

  useInput((input, key) => {
    if (pane !== "left") return;
    if (showCreate) return;

    if (input === "n" && !confirmation.pending) {
      setShowCreate(true);
      return;
    }

    if (input === "e" && selected) {
      // Toggle enable/disable
      asyncState.run(selected.enabled ? "Disabling..." : "Enabling...", async () => {
        if (selected.enabled) {
          await ark.scheduleDisable(selected.id);
        } else {
          await ark.scheduleEnable(selected.id);
        }
        refresh();
        status.show(selected.enabled ? "Schedule disabled" : "Schedule enabled");
      });
    } else if (input === "x" && selected) {
      if (confirmation.confirm("delete", `Delete schedule '${selected.summary ?? selected.id}'? Press x again to confirm`)) {
        asyncState.run("Deleting...", async () => {
          await ark.scheduleDelete(selected.id);
          refresh();
          status.show("Schedule deleted");
        });
      }
    } else if (input === "r") {
      asyncState.run("Refreshing...", async () => {
        refresh();
        status.show("Schedules refreshed");
      });
    }
  });

  if (showCreate) {
    return (
      <NewScheduleForm
        ark={ark}
        asyncState={asyncState}
        onDone={() => {
          setShowCreate(false);
          refresh();
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <SplitPane
        focus={pane}
        leftTitle={`Schedules (${schedules.length})`}
        rightTitle="Details"
        left={
          sorted.length === 0 ? (
            <Text dimColor>No schedules configured.</Text>
          ) : (
            <Box flexDirection="column">
              {sorted.map((s, i) => {
                const isSel = i === sel;
                const icon = s.enabled ? "\u25CF" : "\u25CB";
                const iconColor = s.enabled ? "green" : "gray";
                const summary = (s.summary ?? s.id).slice(0, 30).padEnd(32);
                const cron = s.cron.padEnd(16);
                return (
                  <Text key={s.id} inverse={isSel}>
                    {isSel ? " > " : "   "}
                    <Text color={iconColor}>{icon}</Text>
                    {` ${summary}${cron}`}
                  </Text>
                );
              })}
            </Box>
          )
        }
        right={
          <ScheduleDetail schedule={selected} pane={pane} />
        }
      />
      {(status.message || confirmation.status.message) && (
        <Box>
          <Text color={confirmation.pending === "delete" ? "red" : theme.accent}>
            {` ${confirmation.status.message ?? status.message}`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// -- Detail ------------------------------------------------------------------

interface ScheduleDetailProps {
  schedule: Schedule | null;
  pane: "left" | "right";
}

function ScheduleDetail({ schedule: s, pane }: ScheduleDetailProps) {
  if (!s) {
    return <Box flexGrow={1}><Text dimColor>{"  No schedule selected."}</Text></Box>;
  }

  return (
    <DetailPanel active={pane === "right"}>
      {/* Header */}
      <Text bold>{` ${s.summary ?? s.id}`}</Text>

      {/* Status */}
      <KeyValue label="Status" width={14}>
        <Text color={s.enabled ? "green" : "gray"}>{s.enabled ? "enabled" : "disabled"}</Text>
      </KeyValue>

      {/* Cron */}
      <KeyValue label="Cron" width={14}>
        <Text>{s.cron}</Text>
      </KeyValue>

      {/* Cron description */}
      <KeyValue label="Schedule" width={14}>
        <Text dimColor>{describeCron(s.cron)}</Text>
      </KeyValue>

      {/* Flow */}
      <KeyValue label="Flow" width={14}>
        <Text>{s.flow ?? "-"}</Text>
      </KeyValue>

      {/* Repo */}
      {s.repo && (
        <KeyValue label="Repo" width={14}>
          <Text>{s.repo}</Text>
        </KeyValue>
      )}

      {/* Workdir */}
      {s.workdir && (
        <KeyValue label="Workdir" width={14}>
          <Text>{s.workdir}</Text>
        </KeyValue>
      )}

      {/* Compute */}
      {s.compute_name && (
        <KeyValue label="Compute" width={14}>
          <Text>{s.compute_name}</Text>
        </KeyValue>
      )}

      {/* Group */}
      {s.group_name && (
        <KeyValue label="Group" width={14}>
          <Text>{s.group_name}</Text>
        </KeyValue>
      )}

      <Text> </Text>

      {/* Last run */}
      <KeyValue label="Last Run" width={14}>
        <Text>{s.last_run ?? "never"}</Text>
      </KeyValue>

      {/* Created */}
      <KeyValue label="Created" width={14}>
        <Text>{s.created_at}</Text>
      </KeyValue>
    </DetailPanel>
  );
}

// -- New Schedule Form -------------------------------------------------------

interface NewScheduleFormProps {
  ark: ReturnType<typeof useArkClient>;
  asyncState: ReturnType<typeof useAsync>;
  onDone: () => void;
}

function NewScheduleForm({ ark, asyncState, onDone }: NewScheduleFormProps) {
  const theme = getTheme();
  const [cron, setCron] = useState("*/30 * * * *");
  const [summary, setSummary] = useState("");
  const [flow, setFlow] = useState("bare");
  const [repo, setRepo] = useState(process.cwd());
  const [computeName, setComputeName] = useState("local");
  const [groupName, setGroupName] = useState("");

  const flowChoices = [
    { label: "bare", value: "bare" },
    { label: "default", value: "default" },
    { label: "quick", value: "quick" },
    { label: "parallel", value: "parallel" },
  ];

  // Load computes and groups for selects
  const [computeChoices, setComputeChoices] = useState([{ label: "local", value: "local" }]);
  const [groupChoices, setGroupChoices] = useState([{ label: "(none)", value: "" }]);

  useEffect(() => {
    ark.computeList().then(computes => {
      setComputeChoices(computes.map(c => ({
        label: c.provider === "local" ? "local" : `${c.name} (${c.provider})`,
        value: c.name,
      })));
    }).catch(() => {});

    ark.groupList().then(groups => {
      setGroupChoices([
        { label: "(none)", value: "" },
        ...groups.map(g => ({ label: g.name, value: g.name })),
      ]);
    }).catch(() => {});
  }, []);

  const submit = () => {
    if (!cron.trim()) return;
    asyncState.run("Creating schedule...", async () => {
      await ark.scheduleCreate({
        cron: cron.trim(),
        summary: summary.trim() || undefined,
        flow: flow || "bare",
        repo: repo || process.cwd(),
        compute_name: computeName || undefined,
        group_name: groupName || undefined,
      });
      onDone();
    });
  };

  const { active, advance, setEditing } = useFormNavigation({
    fields: [
      { name: "cron", type: "text" },
      { name: "summary", type: "text" },
      { name: "repo", type: "text" },
      { name: "flow", type: "select" },
      { name: "compute", type: "select" },
      { name: "group", type: "select" },
    ],
    onCancel: onDone,
    onSubmit: submit,
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color={theme.accent}>{" New Schedule "}</Text>
      <Text> </Text>

      <FormTextField
        label="Cron"
        value={cron}
        onChange={setCron}
        active={active === "cron"}
        onEditChange={setEditing}
        placeholder="*/30 * * * *"
      />

      <FormTextField
        label="Summary"
        value={summary}
        onChange={setSummary}
        active={active === "summary"}
        onEditChange={setEditing}
        placeholder="What should the scheduled agent do?"
      />

      <FormTextField
        label="Repo"
        value={repo}
        onChange={setRepo}
        active={active === "repo"}
        onEditChange={setEditing}
        placeholder="/path/to/repo"
      />

      <FormSelectField
        label="Flow"
        value={flow}
        items={flowChoices}
        onSelect={(v) => { setFlow(v); advance(); }}
        active={active === "flow"}
      />

      <FormSelectField
        label="Compute"
        value={computeName}
        items={computeChoices}
        onSelect={(v) => { setComputeName(v); advance(); }}
        active={active === "compute"}
        displayValue={computeName || "local"}
      />

      <FormSelectField
        label="Group"
        value={groupName}
        items={groupChoices}
        onSelect={(v) => { setGroupName(v); submit(); }}
        active={active === "group"}
        displayValue={groupName || "(none)"}
      />

      {cron.trim() && (
        <Box marginTop={1}>
          <Text dimColor>{`  Schedule: ${describeCron(cron.trim())}`}</Text>
        </Box>
      )}

      <Box flexGrow={1} />
    </Box>
  );
}

// -- Cron description helper ------------------------------------------------

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;

  const [min, hour, dom, month, dow] = parts;

  // Common patterns
  if (min === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "every minute";
  if (hour === "*" && dom === "*" && month === "*" && dow === "*") {
    if (min.startsWith("*/")) return `every ${min.slice(2)} minutes`;
    return `at minute ${min}, every hour`;
  }
  if (dom === "*" && month === "*" && dow === "*") {
    if (hour.startsWith("*/")) return `every ${hour.slice(2)} hours at :${min.padStart(2, "0")}`;
    return `daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  if (dom === "*" && month === "*" && dow !== "*") {
    return `${hour.padStart(2, "0")}:${min.padStart(2, "0")} on day-of-week ${dow}`;
  }

  return cron;
}

export function getSchedulesHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS, sep(0),
    <KeyHint key="n" k="n" label="new" />,
    <KeyHint key="e" k="e" label="enable/disable" />,
    <KeyHint key="x" k="x" label="delete" />,
    <KeyHint key="r" k="r" label="refresh" />,
    ...GLOBAL_HINTS,
  ];
}
