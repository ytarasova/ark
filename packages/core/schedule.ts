import { randomBytes } from "crypto";
import type { AppContext } from "./app.js";
import { now } from "./util/time.js";

export interface Schedule {
  id: string;
  cron: string;
  flow: string;
  repo?: string;
  workdir?: string;
  summary?: string;
  compute_name?: string;
  group_name?: string;
  enabled: boolean;
  last_run?: string;
  tenant_id: string;
  user_id?: string;
  created_at: string;
}

interface ScheduleRow {
  id: string;
  cron: string;
  flow: string;
  repo: string | null;
  workdir: string | null;
  summary: string | null;
  compute_name: string | null;
  group_name: string | null;
  enabled: number;
  last_run: string | null;
  tenant_id: string;
  user_id: string | null;
  created_at: string;
}

function genId() {
  return `sched-${randomBytes(3).toString("hex")}`;
}

export function createSchedule(
  app: AppContext,
  opts: {
    cron: string;
    flow?: string;
    repo?: string;
    workdir?: string;
    summary?: string;
    compute_name?: string;
    group_name?: string;
    user_id?: string;
  },
): Schedule {
  const db = app.db;
  const tenantId = app.sessions.getTenant();
  const id = genId();
  const ts = now();
  db.prepare(
    `INSERT INTO schedules (id, cron, flow, repo, workdir, summary, compute_name, group_name, tenant_id, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.cron,
    opts.flow ?? "bare",
    opts.repo ?? null,
    opts.workdir ?? null,
    opts.summary ?? null,
    opts.compute_name ?? null,
    opts.group_name ?? null,
    tenantId,
    opts.user_id ?? null,
    ts,
  );
  return getSchedule(app, id)!;
}

export function listSchedules(app: AppContext): Schedule[] {
  const db = app.db;
  const tenantId = app.sessions.getTenant();
  return (
    db.prepare("SELECT * FROM schedules WHERE tenant_id = ? ORDER BY created_at DESC").all(tenantId) as ScheduleRow[]
  ).map(mapRow);
}

export function getSchedule(app: AppContext, id: string): Schedule | null {
  const db = app.db;
  const tenantId = app.sessions.getTenant();
  const row = db.prepare("SELECT * FROM schedules WHERE id = ? AND tenant_id = ?").get(id, tenantId) as
    | ScheduleRow
    | undefined;
  return row ? mapRow(row) : null;
}

export function deleteSchedule(app: AppContext, id: string): boolean {
  const db = app.db;
  const tenantId = app.sessions.getTenant();
  const result = db.prepare("DELETE FROM schedules WHERE id = ? AND tenant_id = ?").run(id, tenantId);
  return result.changes > 0;
}

export function updateScheduleLastRun(app: AppContext, id: string): void {
  const db = app.db;
  const tenantId = app.sessions.getTenant();
  db.prepare("UPDATE schedules SET last_run = ? WHERE id = ? AND tenant_id = ?").run(now(), id, tenantId);
}

export function enableSchedule(app: AppContext, id: string, enabled: boolean): void {
  const db = app.db;
  const tenantId = app.sessions.getTenant();
  db.prepare("UPDATE schedules SET enabled = ? WHERE id = ? AND tenant_id = ?").run(enabled ? 1 : 0, id, tenantId);
}

function mapRow(r: ScheduleRow): Schedule {
  return { ...r, enabled: !!r.enabled };
}

// ── Cron matching ──────────────────────────────────────────────────────────

/** Check if a 5-field cron expression matches the given time. */
export function cronMatches(cron: string, date?: Date): boolean {
  const d = date ?? new Date();
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const checks = [
    { value: d.getMinutes(), field: fields[0] }, // minute 0-59
    { value: d.getHours(), field: fields[1] }, // hour 0-23
    { value: d.getDate(), field: fields[2] }, // day of month 1-31
    { value: d.getMonth() + 1, field: fields[3] }, // month 1-12
    { value: d.getDay(), field: fields[4] }, // day of week 0-6 (0=Sunday)
  ];

  return checks.every(({ value, field }) => fieldMatches(field, value));
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;

  // Comma-separated values: "1,5,10"
  for (const part of field.split(",")) {
    // Range: "1-5"
    if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      if (value >= lo && value <= hi) return true;
    }
    // Step: "*/5"
    else if (part.startsWith("*/")) {
      const step = Number(part.slice(2));
      if (step > 0 && value % step === 0) return true;
    }
    // Exact value
    else if (Number(part) === value) return true;
  }

  return false;
}
