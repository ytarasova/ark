#!/usr/bin/env node
/**
 * Ark CLI - autonomous agent ecosystem.
 *
 * ark session start --repo . --summary "Add auth" --dispatch
 * ark session list
 * ark session dispatch s-abc123
 * ark session attach s-abc123
 * ark tui
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve, basename } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import * as core from "../core/index.js";
import { getProvider } from "../compute/index.js";

const program = new Command()
  .name("ark")
  .description("Ark - autonomous agent ecosystem")
  .version("0.1.0");

// ── Session commands ────────────────────────────────────────────────────────

const session = program.command("session").description("Manage SDLC pipeline sessions");

session.command("start")
  .description("Start a new session")
  .argument("[ticket]", "External ticket reference (Jira key, GitHub issue, etc.)")
  .option("-r, --repo <path>", "Repository path or name")
  .option("-s, --summary <text>", "Task summary")
  .option("-p, --pipeline <name>", "Pipeline name", "default")
  .option("-c, --compute <name>", "Compute name")
  .option("-g, --group <name>", "Group name")
  .option("-d, --dispatch", "Auto-dispatch the first stage agent")
  .option("-a, --attach", "Dispatch and attach to the session")
  .action(async (ticket, opts) => {
    let workdir: string | undefined;
    let repo = opts.repo;
    if (repo) {
      const rp = resolve(repo);
      if (existsSync(rp)) {
        workdir = rp;
        if (repo === "." || repo === "./") repo = basename(rp);
      }
    }

    const s = core.startSession({
      ticket, summary: opts.summary ?? ticket,
      repo, pipeline: opts.pipeline, compute_name: opts.compute,
      workdir, group_name: opts.group,
    });

    console.log(chalk.green(`Session ${s.id} created`));
    console.log(`  Summary:  ${s.summary ?? "-"}`);
    console.log(`  Repo:     ${s.repo ?? "-"}`);
    console.log(`  Pipeline: ${s.pipeline}`);
    console.log(`  Stage:    ${s.stage ?? "-"}`);
    if (workdir) console.log(`  Workdir:  ${workdir}`);

    if (opts.dispatch || opts.attach) {
      const result = await core.dispatch(s.id);
      if (result.ok) {
        console.log(chalk.green(`Agent dispatched - session: ${result.message}`));
        if (opts.attach) {
          const cmd = core.attachCommand(result.message);
          execSync(cmd, { stdio: "inherit" });
        }
      } else {
        console.log(chalk.red(`Dispatch failed: ${result.message}`));
      }
    }
  });

session.command("list")
  .description("List all sessions")
  .option("-s, --status <status>", "Filter by status")
  .option("-r, --repo <repo>", "Filter by repo")
  .option("-g, --group <group>", "Filter by group")
  .action((opts) => {
    const sessions = core.listSessions(opts);
    if (!sessions.length) {
      console.log(chalk.dim("No sessions. Start one: ark session start --repo . --summary 'task'"));
      return;
    }
    const icons: Record<string, string> = {
      running: "●", waiting: "⏸", pending: "○", ready: "◎",
      completed: "✓", failed: "✕", blocked: "■",
    };
    const colors: Record<string, (s: string) => string> = {
      running: chalk.blue, waiting: chalk.yellow, completed: chalk.green,
      failed: chalk.red, blocked: chalk.yellow,
    };
    for (const s of sessions) {
      const icon = icons[s.status] ?? "?";
      const color = colors[s.status] ?? chalk.dim;
      const group = s.group_name ? chalk.dim(`[${s.group_name}] `) : "";
      const summary = s.summary ?? s.ticket ?? s.repo ?? "-";
      console.log(`  ${color(icon)} ${s.id}  ${group}${summary.slice(0, 40)}  ${s.stage ?? "-"}  ${s.status}`);
    }
  });

session.command("show")
  .description("Show session details")
  .argument("<id>", "Session ID")
  .action((id) => {
    const s = core.getSession(id);
    if (!s) { console.log(chalk.red(`Session ${id} not found`)); return; }
    console.log(chalk.bold(`\n${s.ticket ?? s.id}: ${s.summary ?? ""}`));
    console.log(`  ID:       ${s.id}`);
    console.log(`  Status:   ${s.status}`);
    console.log(`  Stage:    ${s.stage ?? "-"}`);
    console.log(`  Repo:     ${s.repo ?? "-"}`);
    console.log(`  Pipeline: ${s.pipeline}`);
    if (s.agent) console.log(`  Agent:    ${s.agent}`);
    if (s.error) console.log(chalk.red(`  Error:    ${s.error}`));
    if (s.breakpoint_reason) console.log(chalk.yellow(`  Waiting:  ${s.breakpoint_reason}`));
  });

session.command("dispatch")
  .description("Dispatch the agent for the current stage")
  .argument("<id>", "Session ID")
  .action(async (id) => {
    const r = await core.dispatch(id);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("stop")
  .description("Stop a session")
  .argument("<id>")
  .action((id) => {
    const r = core.stop(id);
    console.log(r.ok ? chalk.yellow("Stopped") : chalk.red(r.message));
  });

session.command("resume")
  .description("Resume a stopped/paused session")
  .argument("<id>")
  .action(async (id) => {
    const r = await core.resume(id);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("advance")
  .description("Advance to the next pipeline stage")
  .argument("<id>")
  .option("-f, --force", "Force past gate")
  .action((id, opts) => {
    const r = core.advance(id, opts.force);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("complete")
  .description("Mark current stage done and advance")
  .argument("<id>")
  .action((id) => {
    const r = core.complete(id);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("pause")
  .description("Pause a session")
  .argument("<id>")
  .option("-r, --reason <text>")
  .action((id, opts) => {
    const r = core.pause(id, opts.reason);
    console.log(r.ok ? chalk.yellow("Paused") : chalk.red(r.message));
  });

session.command("attach")
  .description("Attach to a running agent session")
  .argument("<id>")
  .action(async (id) => {
    let s = core.getSession(id);
    if (!s) { console.log(chalk.red("Not found")); return; }
    if (!s.session_id) {
      console.log(chalk.yellow("No active session. Dispatching..."));
      const r = await core.dispatch(id);
      if (!r.ok) { console.log(chalk.red(r.message)); return; }
      s = core.getSession(id)!;
    }
    const cmd = core.attachCommand(s.session_id!);
    require("child_process").execSync(cmd, { stdio: "inherit" });
  });

session.command("output")
  .description("Show live output from a running session")
  .argument("<id>")
  .option("-n, --lines <n>", "Number of lines", "30")
  .action((id, opts) => {
    const output = core.getOutput(id, { lines: Number(opts.lines) });
    console.log(output || chalk.dim("No output"));
  });

session.command("send")
  .description("Send a message to a running Claude session")
  .argument("<id>")
  .argument("<message>")
  .action((id, message) => {
    const r = core.send(id, message);
    console.log(r.ok ? chalk.green("Sent") : chalk.red(r.message));
  });

session.command("clone")
  .description("Clone a session (resumes Claude conversation)")
  .argument("<id>")
  .option("-t, --task <text>", "New task description")
  .option("-d, --dispatch", "Auto-dispatch")
  .action(async (id, opts) => {
    const r = core.cloneSession(id, opts.task);
    if (r.ok) {
      console.log(chalk.green(`Cloned → ${r.cloneId}`));
      if (opts.dispatch) await core.dispatch(r.cloneId);
    } else {
      console.log(chalk.red(r.cloneId));
    }
  });

session.command("handoff")
  .description("Hand off to a different agent")
  .argument("<id>")
  .argument("<agent>")
  .option("-i, --instructions <text>")
  .action(async (id, agent, opts) => {
    const r = await core.handoff(id, agent, opts.instructions);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("fork")
  .description("Fork a child session for parallel work")
  .argument("<parent-id>")
  .argument("<task>")
  .action((parentId, task) => {
    const r = core.fork(parentId, task);
    console.log(r.ok ? chalk.green(`Forked → ${r.childId}`) : chalk.red(r.childId));
  });

session.command("join")
  .description("Join all forked children")
  .argument("<parent-id>")
  .option("-f, --force")
  .action((parentId, opts) => {
    const r = core.joinFork(parentId, opts.force);
    console.log(r.ok ? chalk.green(r.message) : chalk.yellow(r.message));
  });

session.command("events")
  .description("Show event history")
  .argument("<id>")
  .action(async (id) => {
    const { formatEvent } = await import("../tui/helpers/formatEvent.js");
    const events = core.getEvents(id);
    for (const e of events) {
      const ts = e.created_at.slice(11, 16);
      const msg = formatEvent(e.type, e.data ?? undefined);
      console.log(`  ${chalk.dim(ts)}  ${msg}`);
    }
  });

session.command("delete")
  .description("Delete sessions")
  .argument("<ids...>")
  .action((ids: string[]) => {
    for (const id of ids) {
      const s = core.getSession(id);
      if (s?.session_id) core.killSession(s.session_id);
      core.deleteSession(id);
      console.log(chalk.green(`Deleted ${id}`));
    }
  });

session.command("group")
  .description("Assign a session to a group")
  .argument("<id>")
  .argument("<group>")
  .action((id, group) => {
    core.updateSession(id, { group_name: group });
    console.log(chalk.green(`${id} → group '${group}'`));
  });

// ── Agent commands ──────────────────────────────────────────────────────────

const agent = program.command("agent").description("Manage agent definitions");

agent.command("list").description("List agents").action(() => {
  for (const a of core.listAgents()) {
    console.log(`  ${a.name.padEnd(16)} ${a.model.padEnd(8)} T:${a.tools.length} M:${a.mcp_servers.length} S:${a.skills.length} R:${a.memories.length}  ${a.description.slice(0, 40)}`);
  }
});

agent.command("show").description("Show agent details").argument("<name>").action((name) => {
  const a = core.loadAgent(name);
  if (!a) { console.log(chalk.red("Not found")); return; }
  console.log(chalk.bold(`\n${a.name}`) + chalk.dim(` (${a._source})`));
  console.log(`  Model:      ${a.model}`);
  console.log(`  Max turns:  ${a.max_turns}`);
  console.log(`  Tools:      ${a.tools.join(", ")}`);
  console.log(`  MCPs:       ${a.mcp_servers.length ? a.mcp_servers.join(", ") : "-"}`);
  console.log(`  Skills:     ${a.skills.length ? a.skills.join(", ") : "-"}`);
  console.log(`  Memories:   ${a.memories.length ? a.memories.join(", ") : "-"}`);
});

// ── Pipeline commands ───────────────────────────────────────────────────────

const pipe = program.command("pipeline").description("Manage pipelines");

pipe.command("list").description("List pipelines").action(() => {
  for (const p of core.listPipelines()) {
    console.log(`  ${p.name.padEnd(16)} ${p.stages.join(" > ")}  ${chalk.dim(p.description.slice(0, 40))}`);
  }
});

pipe.command("show").description("Show pipeline").argument("<name>").action((name) => {
  const p = core.loadPipeline(name);
  if (!p) { console.log(chalk.red("Not found")); return; }
  console.log(chalk.bold(`\n${p.name}`));
  if (p.description) console.log(chalk.dim(`  ${p.description}`));
  for (const [i, s] of p.stages.entries()) {
    const type = s.type ?? (s.action ? "action" : "agent");
    const detail = s.agent ?? s.action ?? "";
    console.log(`  ${i + 1}. ${s.name.padEnd(14)} [${type}:${detail}] gate=${s.gate}${s.optional ? " (optional)" : ""}`);
  }
});

// ── Host commands ───────────────────────────────────────────────────────────

const hostCmd = program.command("host").description("Manage compute hosts");

hostCmd.command("create")
  .description("Create a new compute host")
  .argument("<name>", "Host name")
  .option("--provider <type>", "Provider type", "local")
  // EC2-specific options
  .option("--size <size>", "Instance size: xs (2vCPU/8GB), s (4/16), m (8/32), l (16/64), xl (32/128), xxl (48/192), xxxl (64/256)", "m")
  .option("--arch <arch>", "Architecture: x64, arm", "x64")
  .option("--region <region>", "Region", "us-east-1")
  .option("--profile <profile>", "AWS profile")
  .option("--subnet-id <id>", "Subnet ID")
  .option("--tag <key=value>", "Tag (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
  // Docker-specific options
  .option("--image <image>", "Docker image (default: ubuntu:22.04)")
  .option("--devcontainer", "Use devcontainer.json from project")
  .option("--volume <mount>", "Extra volume mount (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
  .action((name, opts) => {
    if (opts.provider === "local") {
      console.log(chalk.red("Local host is auto-created. Use 'ec2' or 'docker' provider."));
      return;
    }
    try {
      let config: Record<string, unknown>;

      if (opts.provider === "docker") {
        config = {
          image: opts.image ?? "ubuntu:22.04",
          ...(opts.devcontainer ? { devcontainer: true } : {}),
          ...(opts.volume?.length ? { volumes: opts.volume } : {}),
        };
      } else if (opts.provider === "ec2") {
        const tags: Record<string, string> = {};
        for (const t of opts.tag) {
          const [k, ...rest] = t.split("=");
          if (k && rest.length) tags[k] = rest.join("=");
        }
        config = {
          size: opts.size,
          arch: opts.arch,
          region: opts.region,
          ...(opts.profile ? { aws_profile: opts.profile } : {}),
          ...(opts.subnetId ? { subnet_id: opts.subnetId } : {}),
          ...(Object.keys(tags).length ? { tags } : {}),
        };
      } else {
        config = {};
      }

      const host = core.createHost({
        name,
        provider: opts.provider,
        config,
      });

      console.log(chalk.green(`Host '${host.name}' created`));
      console.log(`  Provider: ${host.provider}`);
      console.log(`  Status:   ${host.status}`);

      if (opts.provider === "docker") {
        console.log(`  Image:    ${(config.image as string) ?? "ubuntu:22.04"}`);
        if (config.devcontainer) console.log(`  Devcontainer: yes`);
        if ((config.volumes as string[] | undefined)?.length) {
          console.log(`  Volumes:  ${(config.volumes as string[]).join(", ")}`);
        }
      } else if (opts.provider === "ec2") {
        let sizeLabel = opts.size;
        try {
          const { INSTANCE_SIZES } = require("../compute/providers/ec2/provision.js");
          const tier = INSTANCE_SIZES[opts.size];
          if (tier) sizeLabel = tier.label;
        } catch { /* not ec2 provider */ }
        console.log(`  Size:     ${sizeLabel}`);
        console.log(`  Arch:     ${opts.arch}`);
        console.log(`  Region:   ${opts.region}`);
      }
    } catch (e: any) {
      console.log(chalk.red(`Failed to create host: ${e.message}`));
    }
  });

hostCmd.command("provision")
  .description("Provision a host (create infrastructure)")
  .argument("<name>", "Host name")
  .action(async (name) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }
    const provider = getProvider(host.provider);
    if (!provider) { console.log(chalk.red(`Provider '${host.provider}' not found`)); return; }
    try {
      console.log(chalk.dim(`Provisioning '${name}' via ${host.provider}...`));
      core.updateHost(name, { status: "provisioning" });
      await provider.provision(host);
      core.updateHost(name, { status: "running" });
      console.log(chalk.green(`Host '${name}' provisioned and running`));
    } catch (e: any) {
      core.updateHost(name, { status: "stopped" });
      console.log(chalk.red(`Provision failed: ${e.message}`));
    }
  });

hostCmd.command("start")
  .description("Start a host")
  .argument("<name>", "Host name")
  .action(async (name) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }
    const provider = getProvider(host.provider);
    if (!provider) { console.log(chalk.red(`Provider '${host.provider}' not found`)); return; }
    try {
      await provider.start(host);
      core.updateHost(name, { status: "running" });
      console.log(chalk.green(`Host '${name}' started`));
    } catch (e: any) {
      console.log(chalk.red(`Start failed: ${e.message}`));
    }
  });

hostCmd.command("stop")
  .description("Stop a host")
  .argument("<name>", "Host name")
  .action(async (name) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }
    const provider = getProvider(host.provider);
    if (!provider) { console.log(chalk.red(`Provider '${host.provider}' not found`)); return; }
    try {
      await provider.stop(host);
      core.updateHost(name, { status: "stopped" });
      console.log(chalk.yellow(`Host '${name}' stopped`));
    } catch (e: any) {
      console.log(chalk.red(`Stop failed: ${e.message}`));
    }
  });

hostCmd.command("destroy")
  .description("Destroy a host (remove infrastructure)")
  .argument("<name>", "Host name")
  .action(async (name) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }
    const provider = getProvider(host.provider);
    if (!provider) { console.log(chalk.red(`Provider '${host.provider}' not found`)); return; }
    try {
      await provider.destroy(host);
      core.updateHost(name, { status: "destroyed" });
      console.log(chalk.green(`Host '${name}' destroyed`));
    } catch (e: any) {
      console.log(chalk.red(`Destroy failed: ${e.message}`));
    }
  });

hostCmd.command("delete")
  .description("Delete a host record from the database")
  .argument("<name>", "Host name")
  .action((name) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }
    if (host.status === "running") {
      console.log(chalk.red("Host is running. Stop or destroy it first."));
      return;
    }
    core.deleteHost(name);
    console.log(chalk.green(`Host '${name}' deleted`));
  });

hostCmd.command("update")
  .description("Update host configuration")
  .argument("<name>", "Host name")
  .option("--size <size>", "Instance size")
  .option("--arch <arch>", "Architecture: x64, arm")
  .option("--region <region>", "AWS region")
  .option("--profile <profile>", "AWS profile")
  .option("--subnet-id <id>", "Subnet ID")
  .option("--ingress <cidrs>", "SSH ingress CIDRs (comma-separated, or 'open' for 0.0.0.0/0)")
  .option("--idle-minutes <min>", "Idle shutdown timeout in minutes")
  .option("--set <key=value>", "Set arbitrary config key", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
  .action((name, opts) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }

    const config = { ...host.config } as any;
    if (opts.size) config.size = opts.size;
    if (opts.arch) config.arch = opts.arch;
    if (opts.region) config.region = opts.region;
    if (opts.profile) config.aws_profile = opts.profile;
    if (opts.subnetId) config.subnet_id = opts.subnetId;
    if (opts.ingress) {
      config.ingress_cidrs = opts.ingress === "open"
        ? ["0.0.0.0/0"]
        : opts.ingress.split(",").map((s: string) => s.trim());
    }
    if (opts.idleMinutes) config.idle_minutes = parseInt(opts.idleMinutes);
    for (const kv of opts.set) {
      const [k, ...rest] = kv.split("=");
      if (k && rest.length) config[k] = rest.join("=");
    }

    core.updateHost(name, { config });
    console.log(chalk.green(`Host '${name}' updated`));
    console.log(JSON.stringify(config, null, 2));
  });

hostCmd.command("list")
  .description("List all hosts")
  .action(() => {
    const hosts = core.listHosts();
    if (!hosts.length) {
      console.log(chalk.dim("No hosts. Create one: ark host create <name> --provider local"));
      return;
    }
    console.log(`  ${"NAME".padEnd(20)} ${"PROVIDER".padEnd(10)} ${"STATUS".padEnd(14)} IP`);
    for (const h of hosts) {
      const ip = (h.config as any).ip ?? "-";
      console.log(`  ${h.name.padEnd(20)} ${h.provider.padEnd(10)} ${h.status.padEnd(14)} ${ip}`);
    }
  });

hostCmd.command("status")
  .description("Show host details")
  .argument("<name>", "Host name")
  .action(async (name) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }
    console.log(JSON.stringify(host, null, 2));
    if (host.status === "running") {
      const provider = getProvider(host.provider);
      if (provider) {
        try {
          const snap = await provider.getMetrics(host);
          console.log(chalk.bold("\nMetrics:"));
          console.log(`  CPU:  ${snap.metrics.cpu.toFixed(1)}%`);
          console.log(`  MEM:  ${snap.metrics.memUsedGb.toFixed(1)}/${snap.metrics.memTotalGb.toFixed(1)} GB (${snap.metrics.memPct.toFixed(1)}%)`);
          console.log(`  DISK: ${snap.metrics.diskPct.toFixed(1)}%`);
        } catch (e: any) {
          console.log(chalk.dim(`(metrics unavailable: ${e.message})`));
        }
      }
    }
  });

hostCmd.command("sync")
  .description("Sync environment to/from host")
  .argument("<name>", "Host name")
  .option("--direction <dir>", "Sync direction (push|pull)", "push")
  .action(async (name, opts) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }
    const provider = getProvider(host.provider);
    if (!provider) { console.log(chalk.red(`Provider '${host.provider}' not found`)); return; }
    try {
      console.log(chalk.dim(`Syncing (${opts.direction}) to '${name}'...`));
      await provider.syncEnvironment(host, { direction: opts.direction });
      console.log(chalk.green(`Sync complete (${opts.direction})`));
    } catch (e: any) {
      console.log(chalk.red(`Sync failed: ${e.message}`));
    }
  });

hostCmd.command("metrics")
  .description("Show host metrics")
  .argument("<name>", "Host name")
  .action(async (name) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }
    const provider = getProvider(host.provider);
    if (!provider) { console.log(chalk.red(`Provider '${host.provider}' not found`)); return; }
    try {
      const snap = await provider.getMetrics(host);
      console.log(chalk.bold(`\nHost: ${name}`));
      console.log(`  CPU:       ${snap.metrics.cpu.toFixed(1)}%`);
      console.log(`  MEM:       ${snap.metrics.memUsedGb.toFixed(1)}/${snap.metrics.memTotalGb.toFixed(1)} GB (${snap.metrics.memPct.toFixed(1)}%)`);
      console.log(`  DISK:      ${snap.metrics.diskPct.toFixed(1)}%`);
      console.log(`  NET:       rx=${snap.metrics.netRxMb.toFixed(1)} MB  tx=${snap.metrics.netTxMb.toFixed(1)} MB`);
      console.log(`  Uptime:    ${snap.metrics.uptime}`);
      console.log(`  Sessions:  ${snap.sessions.length}`);
      console.log(`  Processes: ${snap.processes.length}`);
    } catch (e: any) {
      console.log(chalk.red(`Metrics failed: ${e.message}`));
    }
  });

hostCmd.command("default")
  .description("Set default compute host")
  .argument("<name>", "Host name")
  .action((name) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }
    console.log(chalk.green(`Default host set to '${name}' (will be wired in a future release)`));
  });

hostCmd.command("ssh")
  .description("SSH into a host")
  .argument("<name>", "Host name")
  .action((name) => {
    const host = core.getHost(name);
    if (!host) { console.log(chalk.red(`Host '${name}' not found`)); return; }
    const ip = (host.config as any).ip;
    const keyPath = (host.config as any).key_path;
    const user = (host.config as any).ssh_user ?? "ubuntu";
    if (!ip) { console.log(chalk.red(`Host '${name}' has no IP address`)); return; }
    const sshArgs = [`${user}@${ip}`];
    if (keyPath) sshArgs.unshift("-i", keyPath);
    console.log(chalk.dim(`$ ssh ${sshArgs.join(" ")}`));
    try {
      require("child_process").execFileSync("ssh", sshArgs, { stdio: "inherit" });
    } catch (e: any) {
      console.log(chalk.red(`SSH failed: ${e.message}`));
    }
  });

// ── TUI command ─────────────────────────────────────────────────────────────

program.command("tui").description("Launch TUI dashboard").action(async () => {
  await import("../tui/index.js");
});

// ── Conductor command ────────────────────────────────────────────────────────

program.command("conductor")
  .description("Start the conductor server")
  .option("-p, --port <port>", "Port", "19100")
  .action(async (opts) => {
    const { startConductor } = await import("../core/conductor.js");
    startConductor(parseInt(opts.port));
    // Keep alive
    setInterval(() => {}, 60_000);
  });

// ── Run ─────────────────────────────────────────────────────────────────────

program.parse();
