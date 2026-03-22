import { state, selectedHost } from "../state.js";
import { bar } from "../helpers.js";
import { sectionHeader, detailPaneWidth } from "./helpers.js";

export function renderHostDetail(): string[] | null {
  const { sessions, hostSnapshots } = state;
  const h = selectedHost();
  if (!h) return null;

  // Available width inside the detail pane (subtract border + padding)
  const paneWidth = detailPaneWidth();
  const barWidth = Math.max(20, paneWidth - 30); // space for label + value

  const lines: string[] = [];
  const cfg = h.config as Record<string, unknown>;
  lines.push(`{bold} ${h.name}{/bold}  {gray-fg}${h.provider}{/gray-fg}`);
  if (cfg.instanceType) lines.push(` {gray-fg}Instance{/gray-fg}  ${cfg.instanceType}`);
  const sc = h.status === "running" ? "green"
    : h.status === "provisioning" ? "yellow"
    : h.status === "destroyed" ? "red" : "gray";
  // Provisioning status indicator
  const cloudInitDone = cfg.cloud_init_done === true;
  if (h.status === "running" && h.provider === "ec2") {
    if (cloudInitDone) {
      lines.push(` {gray-fg}Status{/gray-fg}    {green-fg}{bold}ready{/bold} - fully provisioned{/green-fg}`);
    } else {
      lines.push(` {gray-fg}Status{/gray-fg}    {yellow-fg}running - cloud-init in progress...{/yellow-fg}`);
    }
  } else {
    lines.push(` {gray-fg}Status{/gray-fg}    {${sc}-fg}${h.status}{/${sc}-fg}`);
  }
  if (cfg.ip) lines.push(` {gray-fg}IP{/gray-fg}        ${cfg.ip}`);
  if (cfg.last_error) lines.push("", ` {red-fg}{bold}Error:{/bold} ${String(cfg.last_error).slice(0, paneWidth - 10)}{/red-fg}`);

  const snap = hostSnapshots.get(h.name);
  if (snap) {
    const m = snap.metrics;
    lines.push("", sectionHeader("Metrics"));
    lines.push(` CPU   ${bar(m.cpu, barWidth)}  ${m.cpu.toFixed(1)}%`);
    lines.push(` MEM   ${bar(m.memPct, barWidth)}  ${m.memUsedGb.toFixed(1)}/${m.memTotalGb.toFixed(1)} GB`);
    lines.push(` DISK  ${bar(m.diskPct, barWidth)}  ${m.diskPct.toFixed(1)}%`);
    lines.push("");
    lines.push(` {gray-fg}Net RX{/gray-fg}  ${m.netRxMb.toFixed(1)} MB   {gray-fg}TX{/gray-fg}  ${m.netTxMb.toFixed(1)} MB`);
    lines.push(` {gray-fg}Uptime{/gray-fg}  ${m.uptime}   {gray-fg}Idle{/gray-fg}  ${m.idleTicks} ticks`);

    if (snap.sessions.length) {
      lines.push("", sectionHeader("Sessions"));
      lines.push(` ${"Name".padEnd(18)} ${"Status".padEnd(10)} ${"Mode".padEnd(8)} ${"CPU".padEnd(6)} ${"MEM".padEnd(6)}`);
      for (const s of snap.sessions) {
        lines.push(` ${s.name.padEnd(18)} ${s.status.padEnd(10)} ${s.mode.padEnd(8)} ${String(s.cpu).padEnd(6)} ${String(s.mem).padEnd(6)}`);
      }
    }

    if (snap.processes.length) {
      lines.push("", sectionHeader("Processes"));
      lines.push(` ${"PID".padEnd(8)} ${"CPU".padEnd(6)} ${"MEM".padEnd(6)} ${"Command"}`);
      for (const p of snap.processes.slice(0, 10)) {
        lines.push(` ${p.pid.padEnd(8)} ${p.cpu.padEnd(6)} ${p.mem.padEnd(6)} ${p.command.slice(0, paneWidth - 24)}`);
      }
    }

    if (snap.docker.length) {
      lines.push("", sectionHeader("Docker"));
      lines.push(` ${"Name".padEnd(18)} ${"CPU".padEnd(8)} ${"MEM".padEnd(10)} ${"Image"}`);
      for (const c of snap.docker) {
        lines.push(` ${c.name.padEnd(18)} ${c.cpu.padEnd(8)} ${c.memory.padEnd(10)} ${c.image.slice(0, paneWidth - 40)}`);
      }
    }
  } else if (h.status === "running") {
    lines.push("", "{gray-fg} Fetching metrics...{/gray-fg}");
  }

  // Activity log
  const logs = state.hostLogs.get(h.name);
  if (logs?.length) {
    lines.push("", sectionHeader("Activity Log"));
    for (const entry of logs.slice(-15)) {
      lines.push(` {gray-fg}${entry}{/gray-fg}`);
    }
  }

  // Port status (from running sessions on this host)
  const hostSessions = sessions.filter(s => s.compute_name === h.name && s.status === "running");
  const allPorts: any[] = [];
  for (const s of hostSessions) {
    const ports = (s.config as any)?.ports ?? [];
    allPorts.push(...ports);
  }
  if (allPorts.length > 0) {
    lines.push("", sectionHeader("Ports"));
    for (const p of allPorts) {
      const statusIcon = p.listening ? "{green-fg}●{/green-fg}" : "{red-fg}○{/red-fg}";
      const name = p.name ? ` (${p.name})` : "";
      lines.push(` ${statusIcon} :${p.port}${name}  ${p.source}  ${p.listening ? "listening" : "closed"}`);
    }
  }

  // Cost estimate
  const rate = (h.config as any)?.hourlyRate;
  if (rate) {
    lines.push("", sectionHeader("Cost"));
    lines.push(` $${rate.toFixed(3)}/hr  ~$${(rate * 24).toFixed(2)}/day`);
  }

  return lines;
}
