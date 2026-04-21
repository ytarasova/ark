import { nanoid } from "nanoid";
import type { IDatabase } from "../database/index.js";
import { now } from "../util/time.js";

export type LedgerEntryType = "fact" | "hypothesis" | "plan_step" | "progress" | "stall";
export type LedgerEntryStatus = "pending" | "in_progress" | "completed" | "stalled";

export interface LedgerEntry {
  id: string;
  type: LedgerEntryType;
  content: string;
  status?: LedgerEntryStatus;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Ledger {
  conductorId: string;
  entries: LedgerEntry[];
  /** Timestamp of the most-recent entry across all types. */
  lastActivity: string;
  /** Number of recorded "stall" entries -- derived from the entries list. */
  stallCount: number;
}

interface LedgerEntryRow {
  id: string;
  conductor_id: string;
  tenant_id: string;
  type: string;
  content: string;
  status: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEntry(row: LedgerEntryRow): LedgerEntry {
  return {
    id: row.id,
    type: row.type as LedgerEntryType,
    content: row.content,
    status: (row.status as LedgerEntryStatus | null) ?? undefined,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Append-only conductor progress ledger -- facts, hypotheses, plan steps,
 * progress reports, stall markers. Replaces the old filesystem-backed
 * `ledger.json` module so each tenant's ledger lives on a tenant-scoped DB
 * row instead of collapsing into one local JSON blob.
 *
 * The primary key is the entry id (`le-xxxxxx`); `conductor_id` scopes
 * entries to a named conductor (today always `"default"`, kept for forward
 * compatibility with per-workspace conductors); `tenant_id` scopes them to
 * the caller's tenant and is stamped from `setTenant`.
 *
 * `loadLedger` derives `lastActivity` + `stallCount` from the entry rows,
 * so there is no second metadata table to keep in sync.
 */
export class LedgerRepository {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }
  getTenant(): string {
    return this.tenantId;
  }

  async load(conductorId: string): Promise<Ledger> {
    const rows = (await this.db
      .prepare("SELECT * FROM ledger_entries WHERE conductor_id = ? AND tenant_id = ? ORDER BY created_at ASC, id ASC")
      .all(conductorId, this.tenantId)) as LedgerEntryRow[];
    const entries = rows.map(rowToEntry);
    const stallCount = entries.filter((e) => e.type === "stall").length;
    const lastActivity = entries.length > 0 ? entries[entries.length - 1].updatedAt : new Date().toISOString();
    return { conductorId, entries, lastActivity, stallCount };
  }

  async addEntry(
    conductorId: string,
    type: LedgerEntryType,
    content: string,
    sessionId?: string,
  ): Promise<LedgerEntry> {
    const ts = now();
    const entry: LedgerEntry = {
      id: `le-${nanoid(10)}`,
      type,
      content,
      status: type === "plan_step" ? "pending" : undefined,
      sessionId,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.db
      .prepare(
        `INSERT INTO ledger_entries
           (id, conductor_id, tenant_id, type, content, status, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        conductorId,
        this.tenantId,
        entry.type,
        entry.content,
        entry.status ?? null,
        entry.sessionId ?? null,
        entry.createdAt,
        entry.updatedAt,
      );
    return entry;
  }

  async updateEntry(
    conductorId: string,
    entryId: string,
    updates: Partial<Pick<LedgerEntry, "type" | "content" | "status" | "sessionId">>,
  ): Promise<void> {
    const existing = (await this.db
      .prepare("SELECT * FROM ledger_entries WHERE id = ? AND conductor_id = ? AND tenant_id = ?")
      .get(entryId, conductorId, this.tenantId)) as LedgerEntryRow | undefined;
    if (!existing) return;
    const merged: LedgerEntryRow = {
      ...existing,
      type: updates.type ?? existing.type,
      content: updates.content ?? existing.content,
      status: updates.status !== undefined ? updates.status : existing.status,
      session_id: updates.sessionId !== undefined ? (updates.sessionId ?? null) : existing.session_id,
      updated_at: now(),
    };
    await this.db
      .prepare(
        `UPDATE ledger_entries SET type = ?, content = ?, status = ?, session_id = ?, updated_at = ?
         WHERE id = ? AND conductor_id = ? AND tenant_id = ?`,
      )
      .run(
        merged.type,
        merged.content,
        merged.status,
        merged.session_id,
        merged.updated_at,
        entryId,
        conductorId,
        this.tenantId,
      );
  }

  /**
   * Stall detection -- returns true if no `progress` entry has been recorded
   * in the last `thresholdMinutes`. Records a one-shot `stall` entry on the
   * transition from "not stalled" to "stalled" so downstream consumers can
   * see the transition in the ledger.
   */
  async detectStall(conductorId: string, thresholdMinutes: number = 10): Promise<boolean> {
    const lastProgressRow = (await this.db
      .prepare(
        `SELECT * FROM ledger_entries
         WHERE conductor_id = ? AND tenant_id = ? AND type = 'progress'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(conductorId, this.tenantId)) as LedgerEntryRow | undefined;
    if (!lastProgressRow) return false;

    const elapsed = Date.now() - new Date(lastProgressRow.created_at).getTime();
    const stalled = elapsed > thresholdMinutes * 60 * 1000;
    if (!stalled) return false;

    const stallCountRow = (await this.db
      .prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE conductor_id = ? AND tenant_id = ? AND type = 'stall'")
      .get(conductorId, this.tenantId)) as { c: number };
    if (stallCountRow.c === 0) {
      await this.addEntry(conductorId, "stall", `No progress for ${thresholdMinutes} minutes`);
    }
    return true;
  }

  /** Markdown summary for injection into the conductor prompt. Empty string if the ledger is empty. */
  async formatPrompt(conductorId: string): Promise<string> {
    const ledger = await this.load(conductorId);
    if (ledger.entries.length === 0) return "";

    const facts = ledger.entries.filter((e) => e.type === "fact").map((e) => `- ${e.content}`);
    const plan = ledger.entries.filter((e) => e.type === "plan_step").map((e) => `- [${e.status}] ${e.content}`);
    const recent = ledger.entries.slice(-5).map((e) => `- [${e.type}] ${e.content}`);

    let out = "\n## Task Ledger\n";
    if (facts.length) out += `### Facts\n${facts.join("\n")}\n`;
    if (plan.length) out += `### Plan\n${plan.join("\n")}\n`;
    if (recent.length) out += `### Recent Activity\n${recent.join("\n")}\n`;
    if (ledger.stallCount > 0) {
      out += `\n⚠ Stall detected (${ledger.stallCount}x). Consider changing strategy.\n`;
    }
    return out;
  }

  /** Wipe every entry for a conductor. Used by tests + cleanup paths. */
  async delete(conductorId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM ledger_entries WHERE conductor_id = ? AND tenant_id = ?")
      .run(conductorId, this.tenantId);
  }
}
