import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
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
import { useHostMetrics } from "../hooks/useHostMetrics.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";

interface HostsTabProps extends StoreData {
  async: AsyncState;
  onShowForm: () => void;
  formOverlay?: React.ReactNode;
}

export function HostsTab({ hosts, sessions, refreshing, async: asyncState, onShowForm, formOverlay }: HostsTabProps) {
  const { exit } = useApp();
  const [sel, setSel] = useState(0);
  const status = useStatusMessage();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { snapshots, logs, addLog } = useHostMetrics(hosts, true);

  const selected = hosts[sel] ?? null;

  useInput((input, key) => {
    // If in confirm-delete mode, only respond to x or cancel
    if (confirmDelete) {
      if (input === "x" && selected) {
        asyncState.run(`Deleting host ${selected.name}`, async () => {
          core.deleteHost(selected.name);
          setSel((s) => Math.max(0, s - 1));
        });
      }
      setConfirmDelete(false);
      return;
    }

    if (input === "j" || key.downArrow) {
      setSel((s) => Math.min(s + 1, hosts.length - 1));
    } else if (input === "k" || key.upArrow) {
      setSel((s) => Math.max(s - 1, 0));
    } else if (input === "g") {
      setSel(0);
    } else if (input === "G") {
      setSel(Math.max(0, hosts.length - 1));
    } else if (key.return) {
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
        });
      } else if (selected.status === "stopped") {
        addLog(selected.name, "Starting host...");
        asyncState.run(`Starting ${selected.name}`, async () => {
          await provider.start(selected);
          core.updateHost(selected.name, { status: "running" });
          addLog(selected.name, "Host started");
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
        exit();
        const keyPath = join(homedir(), ".ssh", `ark-${selected.name}`);
        const host = ip;
        setTimeout(() => {
          try {
            execFileSync("ssh", ["-i", keyPath, "-o", "StrictHostKeyChecking=no", `ubuntu@${host}`], { stdio: "inherit" });
          } catch { /* user exited */ }
          process.exit(0);
        }, 100);
      }
    } else if (input === "c") {
      // Clean orphaned tmux sessions
      asyncState.run("Cleaning orphan sessions", async () => {
        const { listArkSessions, killSession } = await import("../../core/tmux.js");
        const tmuxSessions = listArkSessions();
        let cleaned = 0;
        for (const ts of tmuxSessions) {
          const sessionId = ts.name.replace("ark-", "");
          const dbSession = core.getSession(sessionId);
          if (!dbSession) {
            killSession(ts.name);
            cleaned++;
          }
        }
        // Show result
        if (cleaned > 0) {
          status.show(`Cleaned ${cleaned} orphan session(s)`);
        } else {
          status.show("No orphan sessions found");
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
        left={<HostsList hosts={hosts} sel={sel} />}
        right={formOverlay ??
          <HostDetail
            host={selected}
            snapshot={selected ? snapshots.get(selected.name) : undefined}
            hostLogs={selected ? logs.get(selected.name) : undefined}
            sessions={sessions}
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

// ── List ────────────────────────────────────────────────────────────────────

interface HostsListProps {
  hosts: core.Host[];
  sel: number;
}

function HostsList({ hosts, sel }: HostsListProps) {
  if (hosts.length === 0) {
    return <Text dimColor>{"  No hosts configured."}</Text>;
  }

  return (
    <Box flexDirection="column">
      {hosts.map((h, i) => {
        const isSel = i === sel;
        const iconColor = (
          h.status === "running" ? "green"
          : h.status === "provisioning" ? "yellow"
          : h.status === "destroyed" ? "red"
          : "gray"
        ) as any;
        const icon = h.status === "destroyed" ? "✕" : h.status === "running" ? "●" : "○";
        const ip = (h.config as Record<string, unknown>).ip ?? "";
        const marker = isSel ? ">" : " ";
        const content = `${marker} `;

        return isSel ? (
          <Text key={h.name} bold inverse>
            {` ${content}`}<Text color={iconColor}>{icon}</Text>
            {` ${h.name.padEnd(16)} ${h.provider.padEnd(8)} ${String(ip)} `}
          </Text>
        ) : (
          <Text key={h.name}>
            {` ${content}`}<Text color={iconColor}>{icon}</Text>
            {` ${h.name.padEnd(16)} ${h.provider.padEnd(8)} ${String(ip)}`}
          </Text>
        );
      })}
    </Box>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

interface HostDetailProps {
  host: core.Host | null;
  snapshot?: HostSnapshot;
  hostLogs?: string[];
  sessions: core.Session[];
}

function HostDetail({ host: h, snapshot, hostLogs, sessions }: HostDetailProps) {
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
    <Box flexDirection="column">
      {/* Header */}
      <Text bold>{` ${h.name}`}<Text dimColor>{`  ${h.provider}`}</Text></Text>
      {cfg.instanceType && <Text><Text dimColor>{"  Instance  "}</Text>{String(cfg.instanceType)}</Text>}

      {/* Status */}
      {h.status === "running" && h.provider === "ec2" ? (
        cloudInitDone ? (
          <Text color="green" bold>{"  ready - fully provisioned"}</Text>
        ) : (
          <Text color="yellow">{"  running - cloud-init in progress..."}</Text>
        )
      ) : (
        <Text><Text dimColor>{"  Status    "}</Text><Text color={statusColor}>{h.status}</Text></Text>
      )}

      {cfg.ip && <Text><Text dimColor>{"  IP        "}</Text>{String(cfg.ip)}{cfg.hourlyRate ? <Text dimColor>{`  ($${Number(cfg.hourlyRate).toFixed(2)}/hr)`}</Text> : null}</Text>}

      {cfg.last_error && (
        <>
          <Text> </Text>
          <Text color="red" bold>{`  Error: ${String(cfg.last_error).slice(0, 70)}`}</Text>
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
          <Text>
            <Text dimColor>{"  Net RX  "}</Text>{`${snapshot.metrics.netRxMb.toFixed(1)} MB`}
            <Text dimColor>{"   TX  "}</Text>{`${snapshot.metrics.netTxMb.toFixed(1)} MB`}
          </Text>
          <Text>
            <Text dimColor>{"  Uptime  "}</Text>{snapshot.metrics.uptime}
            <Text dimColor>{"   Idle  "}</Text>{`${snapshot.metrics.idleTicks} ticks`}
          </Text>

          {/* Sessions */}
          {snapshot.sessions.length > 0 && (
            <>
              <Text> </Text>
              <SectionHeader title="Sessions" />
              <Text dimColor>
                {`  ${"Name".padEnd(18)} ${"Status".padEnd(10)} ${"Mode".padEnd(8)} ${"CPU".padEnd(6)} ${"MEM"}`}
              </Text>
              {snapshot.sessions.map((s, i) => (
                <Text key={i}>
                  {`  ${s.name.padEnd(18)} ${s.status.padEnd(10)} ${s.mode.padEnd(8)} ${String(s.cpu).padEnd(6)} ${String(s.mem)}`}
                </Text>
              ))}
            </>
          )}

          {/* Processes */}
          {snapshot.processes.length > 0 && (
            <>
              <Text> </Text>
              <SectionHeader title="Processes" />
              <Text dimColor>
                {`  ${"PID".padEnd(8)} ${"CPU".padEnd(6)} ${"MEM".padEnd(6)} Command`}
              </Text>
              {snapshot.processes.slice(0, 10).map((p, i) => (
                <Text key={i}>
                  {`  ${p.pid.padEnd(8)} ${p.cpu.padEnd(6)} ${p.mem.padEnd(6)} ${p.command.slice(0, 50)}`}
                </Text>
              ))}
            </>
          )}

          {/* Docker */}
          {snapshot.docker.length > 0 && (
            <>
              <Text> </Text>
              <SectionHeader title="Docker" />
              <Text dimColor>
                {`  ${"Name".padEnd(18)} ${"CPU".padEnd(8)} ${"MEM".padEnd(10)} Image`}
              </Text>
              {snapshot.docker.map((c, i) => (
                <Text key={i}>
                  {`  ${c.name.padEnd(18)} ${c.cpu.padEnd(8)} ${c.memory.padEnd(10)} ${c.image.slice(0, 40)}`}
                </Text>
              ))}
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

    </Box>
  );
}
