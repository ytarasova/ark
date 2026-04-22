/**
 * Agent lifecycle routes: launch, kill, status, capture.
 *
 * Wraps tmux. Extracted from server.ts with no behavior change. All
 * session names are validated against SAFE_TMUX_NAME_RE before any
 * shell command is spawned.
 */

import { writeFile } from "fs/promises";
import type {
  AgentLaunchReq,
  AgentLaunchRes,
  AgentKillReq,
  AgentKillRes,
  AgentStatusReq,
  AgentStatusRes,
  AgentCaptureReq,
  AgentCaptureRes,
} from "../types.js";
import { json, readStream, requireSafeTmuxName, SAFE_TMUX_NAME_RE, type BunLike, type RouteCtx } from "../internal.js";

async function agentLaunch(req: AgentLaunchReq): Promise<AgentLaunchRes> {
  const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;
  if (typeof req.sessionName !== "string" || !SAFE_TMUX_NAME_RE.test(req.sessionName)) {
    throw new Error("invalid sessionName: must match [A-Za-z0-9_-]{1,64}");
  }
  if (typeof req.workdir !== "string" || req.workdir.includes("\0")) {
    throw new Error("invalid workdir");
  }
  // Write launcher script to a temp file
  const scriptPath = `/tmp/arkd-launcher-${req.sessionName}.sh`;
  await writeFile(scriptPath, req.script, { mode: 0o755 });

  const proc = Bun.spawn({
    cmd: [
      "tmux",
      "new-session",
      "-d",
      "-s",
      req.sessionName,
      "-x",
      "120",
      "-y",
      "50",
      "-c",
      req.workdir,
      `bash ${scriptPath}`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  return { ok: true };
}

async function agentKill(req: AgentKillReq): Promise<AgentKillRes> {
  const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;
  requireSafeTmuxName(req.sessionName);
  const wasRunning = await isTmuxRunning(req.sessionName);
  if (wasRunning) {
    const proc = Bun.spawn({
      cmd: ["tmux", "kill-session", "-t", req.sessionName],
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  }
  return { ok: true, wasRunning };
}

async function agentStatus(req: AgentStatusReq): Promise<AgentStatusRes> {
  requireSafeTmuxName(req.sessionName);
  const running = await isTmuxRunning(req.sessionName);
  return { running };
}

async function agentCapture(req: AgentCaptureReq): Promise<AgentCaptureRes> {
  const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;
  requireSafeTmuxName(req.sessionName);
  const linesNum = Math.trunc(Number(req.lines ?? 100));
  const lines = Number.isFinite(linesNum) && linesNum > 0 && linesNum <= 100000 ? linesNum : 100;
  const proc = Bun.spawn({
    cmd: ["tmux", "capture-pane", "-t", req.sessionName, "-p", "-e", "-S", `-${lines}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await readStream(proc.stdout);
  await proc.exited;
  return { output: output.trimEnd() };
}

async function isTmuxRunning(sessionName: string): Promise<boolean> {
  const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;
  // Callers of isTmuxRunning have already validated sessionName via
  // requireSafeTmuxName. Re-check here so a future caller cannot drop it.
  if (!SAFE_TMUX_NAME_RE.test(sessionName)) return false;
  const proc = Bun.spawn({
    cmd: ["tmux", "has-session", "-t", sessionName],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return code === 0;
}

export async function handleAgentRoutes(req: Request, path: string, _ctx: RouteCtx): Promise<Response | null> {
  if (req.method === "POST" && path === "/agent/launch") {
    const body = (await req.json()) as AgentLaunchReq;
    return json(await agentLaunch(body));
  }
  if (req.method === "POST" && path === "/agent/kill") {
    const body = (await req.json()) as AgentKillReq;
    return json(await agentKill(body));
  }
  if (req.method === "POST" && path === "/agent/status") {
    const body = (await req.json()) as AgentStatusReq;
    return json(await agentStatus(body));
  }
  if (req.method === "POST" && path === "/agent/capture") {
    const body = (await req.json()) as AgentCaptureReq;
    return json(await agentCapture(body));
  }
  return null;
}
