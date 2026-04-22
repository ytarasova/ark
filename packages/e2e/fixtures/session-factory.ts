import { startSession } from "../../core/services/session-lifecycle.js";
import { killSession } from "../../core/infra/tmux.js";
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
  const app = env.app;
  const session = startSession(app, {
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
  const app = env.app;
  for (const id of env.sessionIds) {
    try {
      const s = app.sessions.get(id);
      if (s?.session_id) {
        try {
          killSession(s.session_id);
        } catch {
          /* cleanup */
        }
      }
      app.sessions.delete(id);
    } catch {
      /* cleanup */
    }
  }
  env.sessionIds.length = 0;
}
