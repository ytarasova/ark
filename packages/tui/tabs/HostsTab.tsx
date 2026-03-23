import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { execFileSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import type { HostSnapshot } from "../../compute/types.js";
import { SplitPane } from "../components/SplitPane.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { MetricBar } from "../components/MetricBar.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { KeyValue } from "../components/KeyValue.js";
import { DataTable } from "../components/DataTable.js";
import { useHostMetrics } from "../hooks/useHostMetrics.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";

interface HostsTabProps extends StoreData {
  async: AsyncState;
  pane: "left" | "right";
  onShowForm: () => void;
  formOverlay?: React.ReactNode;
  refresh: () => void;
}

export function HostsTab({ hosts, sessions, refreshing, refresh, pane, async: asyncState, onShowForm, formOverlay }: HostsTabProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { sel } = useListNavigation(hosts.length, { active: pane === "left" && !formOverlay && !confirmDelete });
  const status = useStatusMessage();
  const { snapshots, logs, addLog } = useHostMetrics(hosts, true);

  const selected = hosts[sel] ?? null;

  useInput((input, key) => {
    if (formOverlay) return;
    if (pane === "right") return;

    // If in confirm-delete mode, only respond to x or cancel
    if (confirmDelete) {
      if (input === "x" && selected) {
        asyncState.run(`Deleting host ${selected.name}`, async () => {
          core.deleteHost(selected.name);
          refresh();
        });
      }
      setConfirmDelete(false);
      return;
    }

    if (key.return) {
      if (selected && (selected.status === "stopped" || selected.status === "destroyed")) {
        const provider = getProvider(selected.provider);
        if (!provider) return;

        addLog(selected.name, "Starting provisioning...");
        core.updateHost(selected.name, { status: "provisioning" });

        asyncState.run(`Provisioning ${selected.name}`, async () => {
          addLog(selected.name, `Provider: ${selected.provider}, size: ${(selected.config as any)?.size ?? "default"}`);

          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Provisioning timed out after 20 minutes")), 1_200_000)
          );
          await Promise.race([
            provider.provision(selected, {
              onLog: (msg: string) => addLog(selected.name, msg),
            }),
            timeout,
          ]);
          core.updateHost(selected.name, { status: "running" });
          addLog(selected.name, "Provisioning complete - host is running");
          refresh();
        });
      }
    } else if (input === "s") {
      if (!selected) return;
      const provider = getProvider(selected.provider);
      if (!provider) return;

      if (selected.status === "running") {
        addLog(selected.name, "Stopping host...");
        asyncState.run(`Stopping ${selected.name}`, async () => {
          await provider.stop(selected);
          core.updateHost(selected.name, { status: "stopped" });
          addLog(selected.name, "Host stopped");
          refresh();
        });
      } else if (selected.status === "stopped") {
        addLog(selected.name, "Starting host...");
        asyncState.run(`Starting ${selected.name}`, async () => {
          await provider.start(selected);
          core.updateHost(selected.name, { status: "running" });
          addLog(selected.name, "Host started");
          refresh();
        });
      }
    } else if (input === "x") {
      if (!selected) return;
      if (selected.status !== "stopped" && selected.status !== "destroyed") {
        addLog(selected.name, `Cannot delete: host is ${selected.status}`);
        return;
      }
      setConfirmDelete(true);
      status.show(`Delete host '${selected.name}'? Press x to confirm, any key to cancel`);
    } else if (input === "a") {
      if (selected?.status === "running") {
        const ip = (selected.config as any)?.ip;
        if (!ip) return;
        const keyPath = join(homedir(), ".ssh", `ark-${selected.name}`);
        const sshCmd = `ssh -i ${keyPath} -o StrictHostKeyChecking=no ubuntu@${ip}`;
        try {
          execFileSync("tmux", ["new-window", "-n", `ssh-${selected.name}`, "bash", "-c", sshCmd], { stdio: "pipe" });
          status.show(`Opened SSH to ${selected.name} in new tmux window`);
        } catch {
          status.show(`Run: ${sshCmd}`);
        }
      }
    } else if (input === "c") {
      // Clean orphaned/zombie tmux sessions
      asyncState.run("Cleaning zombie sessions", async () => {
        const { listArkSessions, killSession } = await import("../../core/tmux.js");
        const tmuxSessions = listArkSessions();
        let cleaned = 0;
        for (const ts of tmuxSessions) {
          const sessionId = ts.name.replace("ark-", "");
          const dbSession = core.getSession(sessionId);
          // Kill if: no DB entry, or DB says it's dead but tmux still lives
          if (!dbSession || ["failed", "completed"].includes(dbSession.status)) {
            killSession(ts.name);
            if (dbSession) {
              core.updateSession(dbSession.id, { session_id: null });
            }
            cleaned++;
          }
        }
        if (cleaned > 0) {
          status.show(`Killed ${cleaned} zombie session(s)`);
          refresh();
        } else {
          status.show("No zombie sessions found");
        }
      });
    } else if (input === "n") {
      onShowForm();
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      {refreshing && <Text><Spinner type="dots" /> <Text dimColor>refreshing...</Text></Text>}
      <SplitPane
        focus={pane}
        leftTitle="Hosts"
        rightTitle="Details"
        left={
          <TreeList
            items={hosts}
            groupBy={h => h.provider}
            renderRow={(h) => {
              const icon = h.status === "destroyed" ? "✕" : h.status === "running" ? "●" : "○";
              const marker = hosts.indexOf(h) === sel ? ">" : " ";
              return ` ${marker} ${icon} ${h.name.padEnd(16)} ${h.provider}`;
            }}
            renderColoredRow={(h) => {
              const iconColor = (h.status === "running" ? "green" : h.status === "provisioning" ? "yellow" : h.status === "destroyed" ? "red" : "gray") as any;
              const icon = h.status === "destroyed" ? "✕" : h.status === "running" ? "●" : "○";
              return <Text>{" "} <Text color={iconColor}>{icon}</Text>{` ${h.name.padEnd(16)} ${h.provider}`}</Text>;
            }}
            sel={sel}
            emptyMessage="No hosts configured."
          />
        }
        right={formOverlay ??
          <HostDetail
            host={selected}
            snapshot={selected ? snapshots.get(selected.name) : undefined}
            hostLogs={selected ? logs.get(selected.name) : undefined}
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

// ── Detail ──────────────────────────────────────────────────────────────────

interface HostDetailProps {
  host: core.Host | null;
  snapshot?: HostSnapshot;
  hostLogs?: string[];
  sessions: core.Session[];
  pane: "left" | "right";
}

function HostDetail({ host: h, snapshot, hostLogs, sessions, pane }: HostDetailProps) {
  if (!h) {
    return <Text dimColor>{"  No host selected"}</Text>;
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
      {hostLogs && hostLogs.length > 0 && (
        <>
          <Text> </Text>
          <SectionHeader title="Activity Log" />
          {hostLogs.slice(-15).map((entry, i) => (
            <Text key={i} dimColor>{`  ${entry}`}</Text>
          ))}
        </>
      )}

      {/* Ports */}
      {(() => {
        const hostSessions = sessions.filter(
          (s) => s.compute_name === h.name && s.status === "running"
        );
        const allPorts: any[] = [];
        for (const s of hostSessions) {
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
                  {"  "}<Text color={p.listening ? "green" : "red"}>{p.listening ? "●" : "○"}</Text>
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
