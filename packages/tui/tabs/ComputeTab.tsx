import React, { useMemo, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import { execFile } from "child_process";
import { join } from "path";
import { homedir } from "os";
import type { Session, Compute } from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import { getComputeStatusColor } from "../helpers/colors.js";
import { KeyHint, sep, NAV_HINTS, GLOBAL_HINTS } from "../helpers/statusBarHints.js";
import type { ComputeSnapshot } from "../../types/index.js";
import { SplitPane } from "../components/SplitPane.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { MetricBar } from "../components/MetricBar.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { KeyValue } from "../components/KeyValue.js";
import { DataTable } from "../components/DataTable.js";
import { useComputeActions } from "../hooks/useComputeActions.js";
import { useFocus } from "../hooks/useFocus.js";
import type { StoreData } from "../hooks/useArkStore.js";
import type { AsyncState } from "../hooks/useAsync.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useConfirmation } from "../hooks/useConfirmation.js";
import { useArkClient } from "../hooks/useArkClient.js";

interface ComputeTabProps extends StoreData {
  asyncState: AsyncState;
  pane: "left" | "right";
  onShowForm: () => void;
  formOverlay?: React.ReactNode;
  refresh: () => void;
}

export function ComputeTab({ computes, sessions, refresh: _refresh, pane, snapshots, computeLogs, addComputeLog, asyncState, onShowForm, formOverlay }: ComputeTabProps) {
  const theme = getTheme();
  const ark = useArkClient();
  const confirmation = useConfirmation();
  const focus = useFocus();
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<Array<{ name: string; description?: string; provider: string; config: Record<string, unknown> }>>([]);

  const [selected, setSelected] = useState<Compute | null>(null);

  const status = useStatusMessage();
  const actions = useComputeActions(asyncState, addComputeLog);

  // Push/pop focus when confirmation is pending
  useEffect(() => {
    if (confirmation.pending) focus.push("confirm");
    else focus.pop("confirm");
  }, [confirmation.pending]);

  const hasOverlay = !!formOverlay || showTemplates;

  useInput((input, key) => {
    if (pane !== "left" || hasOverlay) return;

    if (key.return) {
      if (selected && (selected.status === "stopped" || selected.status === "destroyed")) {
        actions.provision(selected);
      }
    } else if (input === "s") {
      if (!selected) return;
      if (selected.status === "running") {
        if (confirmation.confirm("stop", `Stop '${selected.name}'? Press s again to confirm`)) {
          actions.stop(selected);
        }
      } else if (selected.status === "stopped") {
        actions.start(selected);
      }
    } else if (input === "x") {
      if (!selected) return;
      if (!getProvider(selected.provider)?.canDelete) {
        status.show("Cannot delete this compute");
        return;
      }
      if (confirmation.confirm("delete", `Delete '${selected.name}'? Press x again to confirm`)) {
        actions.delete(selected.name);
      }
    } else if (input === "a") {
      if (selected?.status === "running") {
        const ip = (selected.config as Record<string, unknown>)?.ip as string | undefined;
        if (!ip) return;
        const keyPath = join(homedir(), ".ssh", `ark-${selected.name}`);
        const sshCmd = `ssh -i ${keyPath} -o StrictHostKeyChecking=no ubuntu@${ip}`;
        asyncState.run("Opening SSH...", async () => {
          await new Promise<void>((resolve, reject) => {
            execFile("tmux", ["new-window", "-n", `ssh-${selected.name}`, "bash", "-c", sshCmd], (err, _stdout, _stderr) => {
              if (err) { status.show(`Run: ${sshCmd}`); reject(err); }
              else { status.show(`Opened SSH to ${selected.name}`); resolve(); }
            });
          });
        });
      }
    } else if (input === "R") {
      if (selected && getProvider(selected.provider)?.canReboot) {
        if (confirmation.confirm("reboot", `Reboot '${selected.name}'? Press R again to confirm`)) {
          actions.reboot(selected);
        }
      }
    } else if (input === "t") {
      if (selected) {
        actions.ping(selected);
      }
    } else if (input === "c") {
      actions.clean();
    } else if (input === "n") {
      onShowForm();
    } else if (input === "T") {
      asyncState.run("Loading templates...", async () => {
        const r = await ark.computeTemplateList();
        setTemplates(r.templates ?? []);
        setShowTemplates(true);
      });
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <SplitPane
        focus={pane}
        leftTitle="Compute"
        rightTitle="Details"
        left={
          <TreeList
            items={computes}
            getKey={(h) => h.name}
            groupBy={h => h.provider}
            renderRow={(h) => {
              const icon = h.status === "destroyed" ? "\u2715" /* ✕ cross */ : h.status === "running" ? "\u25CF" /* ● circle */ : "\u25CB";
              return `${icon} ${h.name.padEnd(16)} ${h.provider}`;
            }}
            renderColoredRow={(h) => {
              const iconColor = getComputeStatusColor(h.status);
              const icon = h.status === "destroyed" ? "\u2715" /* ✕ cross */ : h.status === "running" ? "\u25CF" /* ● circle */ : "\u25CB";
              return <Text>{" "} <Text color={iconColor}>{icon}</Text>{` ${h.name.padEnd(16)} ${h.provider}`}</Text>;
            }}
            selectedKey={selected?.name ?? null}
            onSelect={(item) => setSelected(item)}
            active={pane === "left" && !formOverlay && !confirmation.pending && !showTemplates}
            emptyMessage="  No compute configured."
          />
        }
        right={formOverlay ?? (showTemplates ? (
          <TemplatesList templates={templates} onClose={() => setShowTemplates(false)} />
        ) : (
          <ComputeDetail
            compute={selected}
            snapshot={selected ? snapshots.get(selected.name) : undefined}
            computeLogs={selected ? computeLogs.get(selected.name) : undefined}
            sessions={sessions}
            pane={pane}
          />
        ))}
      />
      {status.message && (
        <Box>
          <Text color={confirmation.pending === "delete" ? "red" : theme.accent}>{` ${status.message}`}</Text>
        </Box>
      )}
    </Box>
  );
}

// -- Helpers -----------------------------------------------------------------

interface ComputePort {
  port: number;
  name?: string;
  listening: boolean;
  source: string;
}

function getComputePorts(sessions: Session[], computeName: string): ComputePort[] {
  const ports: ComputePort[] = [];
  for (const s of sessions) {
    if (s.compute_name !== computeName || s.status !== "running") continue;
    const sessionPorts = s.config?.ports ?? [];
    ports.push(...sessionPorts.map(p => ({ ...p, source: p.source ?? "session", listening: true })));
  }
  return ports;
}

// -- Detail ------------------------------------------------------------------

interface ComputeDetailProps {
  compute: Compute | null;
  snapshot?: ComputeSnapshot;
  computeLogs?: string[];
  sessions: Session[];
  pane: "left" | "right";
}

function ComputeDetail({ compute: h, snapshot, computeLogs, sessions, pane }: ComputeDetailProps) {
  const theme = getTheme();
  if (!h) {
    return <Box flexGrow={1}><Text dimColor>{"  No compute selected."}</Text></Box>;
  }

  const cfg = h.config as Record<string, unknown>;
  const statusColor = getComputeStatusColor(h.status);

  const cloudInitDone = cfg.cloud_init_done === true;

  return (
    <DetailPanel active={pane === "right"}>
      {/* Header */}
      <Text bold>{` ${h.name}`}<Text dimColor>{`  ${h.provider}`}</Text></Text>
      {cfg.instanceType && <KeyValue label="Instance" width={12}>{String(cfg.instanceType)}</KeyValue>}

      {/* Status */}
      {h.status === "running" && h.provider === "ec2" ? (
        cloudInitDone ? (
          <Text color={theme.running} bold>{"  ready - fully provisioned"}</Text>
        ) : (
          <Text color={theme.waiting}>{"  running - cloud-init in progress..."}</Text>
        )
      ) : (
        <KeyValue label="Status" width={12}><Text color={statusColor}>{h.status}</Text></KeyValue>
      )}

      {cfg.ip && <KeyValue label="IP" width={12}><Text>{String(cfg.ip)}{cfg.hourlyRate ? <Text dimColor>{`  ($${Number(cfg.hourlyRate).toFixed(2)}/hr)`}</Text> : null}</Text></KeyValue>}

      {cfg.last_error && (
        <>
          <Text> </Text>
          <Text color={theme.error} bold wrap="truncate">{`  Error: ${String(cfg.last_error)}`}</Text>
        </>
      )}

      {/* Metrics */}
      {snapshot && (
        <>
          <Text> </Text>
          <SectionHeader title="Metrics" />
          <MetricBar
            label="CPU"
            value={snapshot.metrics.cpu}
            max={100}
            suffix={`${snapshot.metrics.cpu.toFixed(1)}%`}
          />
          <MetricBar
            label="MEM"
            value={snapshot.metrics.memPct}
            max={100}
            suffix={`${snapshot.metrics.memUsedGb.toFixed(1)}/${snapshot.metrics.memTotalGb.toFixed(1)} GB`}
          />
          <MetricBar
            label="DISK"
            value={snapshot.metrics.diskPct}
            max={100}
            suffix={`${snapshot.metrics.diskPct.toFixed(1)}%`}
          />
          <Text> </Text>
          <KeyValue label="Net RX" width={10}><Text>{`${snapshot.metrics.netRxMb.toFixed(1)} MB`}<Text dimColor>{"   TX  "}</Text>{`${snapshot.metrics.netTxMb.toFixed(1)} MB`}</Text></KeyValue>
          <KeyValue label="Uptime" width={10}><Text>{snapshot.metrics.uptime}<Text dimColor>{"   Idle  "}</Text>{`${snapshot.metrics.idleTicks} ticks`}</Text></KeyValue>

          {/* Sessions */}
          {snapshot.sessions.length > 0 && (
            <>
              <Text> </Text>
              <SectionHeader title="Sessions" />
              <DataTable
                columns={[
                  { key: "name", label: "Name", width: 18 },
                  { key: "status", label: "Status", width: 10 },
                  { key: "mode", label: "Mode", width: 8 },
                  { key: "cpu", label: "CPU", width: 6 },
                  { key: "mem", label: "MEM" },
                ]}
                rows={snapshot.sessions}
              />
            </>
          )}

          {/* Processes */}
          {snapshot.processes.length > 0 && (
            <>
              <Text> </Text>
              <SectionHeader title="Processes" />
              <DataTable
                columns={[
                  { key: "pid", label: "PID", width: 8 },
                  { key: "cpu", label: "CPU", width: 6 },
                  { key: "mem", label: "MEM", width: 6 },
                  { key: "command", label: "Command" },
                ]}
                rows={snapshot.processes}
                limit={10}
              />
            </>
          )}

          {/* Docker */}
          {snapshot.docker.length > 0 && (
            <>
              <Text> </Text>
              <SectionHeader title="Docker" />
              <DataTable
                columns={[
                  { key: "name", label: "Name", width: 18 },
                  { key: "cpu", label: "CPU", width: 8 },
                  { key: "memory", label: "MEM", width: 10 },
                  { key: "image", label: "Image" },
                ]}
                rows={snapshot.docker}
              />
            </>
          )}
        </>
      )}

      {!snapshot && h.status === "running" && (
        <>
          <Text> </Text>
          <Text dimColor>{" Fetching metrics..."}</Text>
        </>
      )}

      {/* Activity log */}
      {computeLogs && computeLogs.length > 0 && (
        <>
          <Text> </Text>
          <SectionHeader title="Activity Log" />
          {computeLogs.slice(-15).map((entry, i) => (
            <Text key={i} dimColor wrap="wrap">{`  ${entry}`}</Text>
          ))}
        </>
      )}

      {/* Ports */}
      <ComputePortList sessions={sessions} computeName={h.name} />

    </DetailPanel>
  );
}

// -- Port list (memoized) ----------------------------------------------------

function ComputePortList({ sessions, computeName }: { sessions: Session[]; computeName: string }) {
  const ports = useMemo(() => getComputePorts(sessions, computeName), [sessions, computeName]);
  if (ports.length === 0) return null;
  return (
    <>
      <Text> </Text>
      <SectionHeader title="Ports" />
      {ports.map((p, i) => {
        const name = p.name ? ` (${p.name})` : "";
        return (
          <Text key={i}>
            {"  "}<Text color={p.listening ? "green" : "red"}>{p.listening ? "\u25CF" /* ● circle */ : "\u25CB"}</Text>
            {` :${p.port}${name}  ${p.source}  ${p.listening ? "listening" : "closed"}`}
          </Text>
        );
      })}
    </>
  );
}

// -- Templates list ----------------------------------------------------------

interface TemplatesListProps {
  templates: Array<{ name: string; description?: string; provider: string; config: Record<string, unknown> }>;
  onClose: () => void;
}

function TemplatesList({ templates, onClose }: TemplatesListProps) {
  const theme = getTheme();

  useInput((_input, key) => {
    if (key.escape) onClose();
  });

  return (
    <DetailPanel active>
      <Text bold color={theme.accent}>{" Compute Templates"}</Text>
      <Text> </Text>
      {templates.length === 0 ? (
        <Text dimColor>{"  No templates defined."}</Text>
      ) : (
        templates.map((t, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text bold>{`  ${t.name}`}<Text dimColor>{`  [${t.provider}]`}</Text></Text>
            {t.description && <Text dimColor>{`    ${t.description}`}</Text>}
            {Object.keys(t.config).length > 0 && (
              <Text dimColor>{`    config: ${JSON.stringify(t.config)}`}</Text>
            )}
          </Box>
        ))
      )}
      <Text> </Text>
      <Text dimColor>{"  Press Esc to close"}</Text>
    </DetailPanel>
  );
}

export function getComputeHints(): React.ReactNode[] {
  return [
    ...NAV_HINTS, sep(0),
    <KeyHint key="enter" k="Enter" label="provision" />,
    <KeyHint key="s" k="s" label="start/stop" />,
    <KeyHint key="R" k="R" label="reboot" />,
    <KeyHint key="t" k="t" label="test" />,
    <KeyHint key="x" k="x" label="delete" />,
    <KeyHint key="c" k="c" label="clean" />,
    <KeyHint key="n" k="n" label="new" />,
    <KeyHint key="T" k="T" label="templates" />,
    ...GLOBAL_HINTS,
  ];
}
