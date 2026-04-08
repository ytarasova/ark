import * as core from "../../core/index.js";
import type { E2EEnv } from "./app.js";

interface CreateOpts {
  summary?: string;
  repo?: string;
  flow?: string;
  group_name?: string;
  ticket?: string;
  compute_name?: string;
  workdir?: string;
}

export function createTestSession(env: E2EEnv, opts: CreateOpts = {}) {
  const session = core.startSession({
    summary: opts.summary ?? `e2e-${Date.now()}`,
    repo: opts.repo ?? env.workdir,
    flow: opts.flow ?? "bare",
    group_name: opts.group_name,
    ticket: opts.ticket,
    compute_name: opts.compute_name,
    workdir: opts.workdir ?? env.workdir,
  });
  env.sessionIds.push(session.id);
  return session;
}

export function cleanupSessions(env: E2EEnv) {
  for (const id of env.sessionIds) {
    try {
      const s = core.getSession(id);
      if (s?.session_id) {
        try { core.killSession(s.session_id); } catch {}
      }
      core.deleteSession(id);
    } catch {}
  }
  env.sessionIds.length = 0;
}
