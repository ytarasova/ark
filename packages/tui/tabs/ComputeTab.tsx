import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { execFile } from "child_process";
import { join } from "path";
import { homedir } from "os";
import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import type { ComputeSnapshot } from "../../compute/types.js";
import { SplitPane } from "../components/SplitPane.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { MetricBar } from "../components/MetricBar.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { KeyValue } from "../components/KeyValue.js";
import { DataTable } from "../components/DataTable.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useComputeActions } from "../hooks/useComputeActions.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";

interface ComputeTabProps extends StoreData {
  async: AsyncState;
  pane: "left" | "right";
  onShowForm: () => void;
  formOverlay?: React.ReactNode;
  refresh: () => void;
}

export function ComputeTab({ computes, sessions, refreshing, refresh, pane, snapshots, computeLogs, addComputeLog, async: asyncState, onShowForm, formOverlay }: ComputeTabProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { sel } = useListNavigation(computes.length, { active: pane === "left" && !formOverlay && !confirmDelete });
  const status = useStatusMessage();
  const actions = useComputeActions(asyncState, addComputeLog);

  const selected = computes[sel] ?? null;

  useInput((input, key) => {
    if (formOverlay) return;
    if (pane === "right") return;

    if (confirmDelete) {
      if (input === "x" && selected) actions.delete(selected.name);
      setConfirmDelete(false);
      return;
    }

    if (key.return) {
      if (selected && (selected.status === "stopped" || selected.status === "destroyed")) {
        actions.provision(selected);
      }
    } else if (input === "s") {
      if (!selected) return;
      if (selected.status === "running") {
        actions.stop(selected);
      } else if (selected.status === "stopped") {
        actions.start(selected);
      }
    } else if (input === "x") {
      if (!selected) return;
      if (selected.status !== "stopped" && selected.status !== "destroyed") {
        addComputeLog(selected.name, `Cannot delete: compute is ${selected.status}`);
        return;
      }
      setConfirmDelete(true);
      status.show(`Delete '${selected.name}'? Press x to confirm`);
    } else if (input === "a") {
      if (selected?.status === "running") {
        const ip = (selected.config as any)?.ip;
        if (!ip) return;
        const keyPath = join(homedir(), ".ssh", `ark-${selected.name}`);
        const sshCmd = `ssh -i ${keyPath} -o StrictHostKeyChecking=no ubuntu@${ip}`;
        asyncState.run("Opening SSH...", async () => {
          await new Promise<void>((resolve, reject) => {
            execFile("tmux", ["new-window", "-n", `ssh-${selected.name}`, "bash", "-c", sshCmd], { stdio: "pipe" }, (err) => {
              if (err) { status.show(`Run: ${sshCmd}`); reject(err); }
              else { status.show(`Opened SSH to ${selected.name}`); resolve(); }
            });
          });
        });
      }
    } else if (input === "c") {
      actions.clean();
    } else if (input === "n") {
      onShowForm();
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      {refreshing && <Text><Spinner type="dots" /> <Text dimColor>refreshing...</Text></Text>}
      <SplitPane
        focus={pane}
        leftTitle="Compute"
        rightTitle="Details"
        left={
          <TreeList
            items={computes}
            groupBy={h => h.provider}
            renderRow={(h) => {
              const icon = h.status === "destroyed" ? "\u2715" : h.status === "running" ? "\u25CF" : "\u25CB";
              const marker = computes.indexOf(h) === sel ? ">" : " ";
              return ` ${marker} ${icon} ${h.name.padEnd(16)} ${h.provider}`;
            }}
            renderColoredRow={(h) => {
              const iconColor = (h.status === "running" ? "green" : h.status === "provisioning" ? "yellow" : h.status === "destroyed" ? "red" : "gray") as any;
              const icon = h.status === "destroyed" ? "\u2715" : h.status === "running" ? "\u25CF" : "\u25CB";
              return <Text>{" "} <Text color={iconColor}>{icon}</Text>{` ${h.name.padEnd(16)} ${h.provider}`}</Text>;
            }}
            sel={sel}
            emptyMessage="No compute configured."
          />
        }
        right={formOverlay ??
          <ComputeDetail
            compute={selected}
            snapshot={selected ? snapshots.get(selected.name) : undefined}
            computeLogs={selected ? computeLogs.get(selected.name) : undefined}
            sessions={sessions}
            pane={pane}
          />
        }
      />
      {status.message && (
        <Box>
          <Text color={confirmDelete ? "red" : "cyan"}>{` ${status.message}`}</Text>
        </Box>
      )}
    </Box>
  );
}

// -- Detail ------------------------------------------------------------------

interface ComputeDetailProps {
  compute: core.Compute | null;
  snapshot?: ComputeSnapshot;
  computeLogs?: string[];
  sessions: core.Session[];
  pane: "left" | "right";
}

function ComputeDetail({ compute: h, snapshot, computeLogs, sessions, pane }: ComputeDetailProps) {
  if (!h) {
    return <Box flexGrow={1}><Text dimColor>{"  No compute selected"}</Text></Box>;
  }

  const cfg = h.config as Record<string, unknown>;
  const statusColor = (
    h.status === "running" ? "green"
    : h.status === "provisioning" ? "yellow"
    : h.status === "destroyed" ? "red"
    : "gray"
  ) as any;

  const cloudInitDone = cfg.cloud_init_done === true;

  return (
    <DetailPanel active={pane === "right"}>
      {/* Header */}
      <Text bold>{` ${h.name}`}<Text dimColor>{`  ${h.provider}`}</Text></Text>
      {cfg.instanceType && <KeyValue label="Instance" width={12}>{String(cfg.instanceType)}</KeyValue>}

      {/* Status */}
      {h.status === "running" && h.provider === "ec2" ? (
        cloudInitDone ? (
          <Text color="green" bold>{"  ready - fully provisioned"}</Text>
        ) : (
          <Text color="yellow">{"  running - cloud-init in progress..."}</Text>
        )
      ) : (
        <KeyValue label="Status" width={12}><Text color={statusColor}>{h.status}</Text></KeyValue>
      )}

      {cfg.ip && <KeyValue label="IP" width={12}><Text>{String(cfg.ip)}{cfg.hourlyRate ? <Text dimColor>{`  ($${Number(cfg.hourlyRate).toFixed(2)}/hr)`}</Text> : null}</Text></KeyValue>}

      {cfg.last_error && (
        <>
          <Text> </Text>
          <Text color="red" bold wrap="truncate">{`  Error: ${String(cfg.last_error)}`}</Text>
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
      {(() => {
        const computeSessions = sessions.filter(
          (s) => s.compute_name === h.name && s.status === "running"
        );
        const allPorts: any[] = [];
        for (const s of computeSessions) {
          const ports = (s.config as any)?.ports ?? [];
          allPorts.push(...ports);
        }
        if (allPorts.length === 0) return null;
        return (
          <>
            <Text> </Text>
            <SectionHeader title="Ports" />
            {allPorts.map((p: any, i: number) => {
              const name = p.name ? ` (${p.name})` : "";
              return (
                <Text key={i}>
                  {"  "}<Text color={p.listening ? "green" : "red"}>{p.listening ? "\u25CF" : "\u25CB"}</Text>
                  {` :${p.port}${name}  ${p.source}  ${p.listening ? "listening" : "closed"}`}
                </Text>
              );
            })}
          </>
        );
      })()}

    </DetailPanel>
  );
}
