/**
 * BurnRepository -- CRUD + aggregation queries against the burn_turns table.
 *
 * Stores per-turn classified data from transcript parsing. The table is
 * treated as a rebuildable cache -- drop and re-sync from transcripts
 * when classifier logic changes.
 */

import type { IDatabase } from "../database/index.js";

export interface BurnTurnRow {
  id?: number;
  session_id: string;
  tenant_id: string;
  turn_index: number;
  project: string | null;
  timestamp: string;
  user_message_preview: string | null;
  category: string;
  model: string | null;
  provider: string | null;
  runtime: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  api_calls: number;
  has_edits: number;
  retries: number;
  is_one_shot: number;
  tools_json: string;
  mcp_tools_json: string;
  bash_cmds_json: string;
  speed: string;
  transcript_mtime: number | null;
}

export interface BurnQueryOpts {
  tenantId?: string;
  since?: string;
  until?: string;
  /** Optional SQLite date modifier like "-4 hours" or IANA zone like "America/New_York". Resolved server-side. */
  tz?: string;
}

export interface BurnOverview {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalApiCalls: number;
  totalSessions: number;
  cacheHitPct: number;
}

export interface CategoryBreakdownRow {
  category: string;
  cost: number;
  turns: number;
  editTurns: number;
  oneShotPct: number | null;
}

export interface ModelBreakdownRow {
  model: string;
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ProjectBreakdownRow {
  project: string;
  cost: number;
  sessions: number;
}

export interface DailyBreakdownRow {
  date: string;
  cost: number;
  calls: number;
}

export interface ToolBreakdownRow {
  tool: string;
  calls: number;
}

export interface BashBreakdownRow {
  cmd: string;
  calls: number;
}

export class BurnRepository {
  constructor(private db: IDatabase) {}

  /** Delete all turns for a session then insert new ones. */
  upsertTurns(sessionId: string, turns: BurnTurnRow[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM burn_turns WHERE session_id = ?").run(sessionId);
      const stmt = this.db.prepare(`
        INSERT INTO burn_turns (
          session_id, tenant_id, turn_index, project, timestamp,
          user_message_preview, category, model, provider, runtime,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, api_calls, has_edits, retries, is_one_shot,
          tools_json, mcp_tools_json, bash_cmds_json, speed, transcript_mtime
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of turns) {
        stmt.run(
          t.session_id, t.tenant_id, t.turn_index, t.project, t.timestamp,
          t.user_message_preview, t.category, t.model, t.provider, t.runtime,
          t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens,
          t.cost_usd, t.api_calls, t.has_edits, t.retries, t.is_one_shot,
          t.tools_json, t.mcp_tools_json, t.bash_cmds_json, t.speed, t.transcript_mtime,
        );
      }
    });
  }

  /** Get all turns for a session ordered by turn_index. */
  getTurns(sessionId: string): BurnTurnRow[] {
    return this.db.prepare(
      "SELECT * FROM burn_turns WHERE session_id = ? ORDER BY turn_index",
    ).all(sessionId) as BurnTurnRow[];
  }

  /** Aggregate overview metrics across all turns matching filters. */
  getOverview(opts: BurnQueryOpts): BurnOverview {
    const { where, params } = this._buildWhere(opts);
    const sql = `
      SELECT
        COALESCE(SUM(cost_usd), 0) as totalCostUsd,
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cache_read_tokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) as totalCacheWriteTokens,
        COALESCE(SUM(api_calls), 0) as totalApiCalls,
        COUNT(DISTINCT session_id) as totalSessions
      FROM burn_turns
      WHERE ${where}
    `;
    const row = this.db.prepare(sql).get(...params) as any;
    const totalPresented = row.totalInputTokens + row.totalCacheReadTokens;
    const cacheHitPct = totalPresented > 0
      ? (row.totalCacheReadTokens / totalPresented) * 100
      : 0;
    return {
      totalCostUsd: row.totalCostUsd,
      totalInputTokens: row.totalInputTokens,
      totalOutputTokens: row.totalOutputTokens,
      totalCacheReadTokens: row.totalCacheReadTokens,
      totalCacheWriteTokens: row.totalCacheWriteTokens,
      totalApiCalls: row.totalApiCalls,
      totalSessions: row.totalSessions,
      cacheHitPct,
    };
  }

  /** Breakdown by category with one-shot percentage. */
  getCategoryBreakdown(opts: BurnQueryOpts): CategoryBreakdownRow[] {
    const { where, params } = this._buildWhere(opts);
    const sql = `
      SELECT
        category,
        SUM(cost_usd) as cost,
        COUNT(*) as turns,
        SUM(has_edits) as editTurns,
        SUM(is_one_shot) as oneShotSum
      FROM burn_turns
      WHERE ${where}
      GROUP BY category
      ORDER BY cost DESC
    `;
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      category: r.category,
      cost: r.cost,
      turns: r.turns,
      editTurns: r.editTurns,
      oneShotPct: r.editTurns > 0
        ? (r.oneShotSum * 100) / r.editTurns
        : null,
    }));
  }

  /** Breakdown by model. */
  getModelBreakdown(opts: BurnQueryOpts): ModelBreakdownRow[] {
    const { where, params } = this._buildWhere(opts);
    const sql = `
      SELECT
        model,
        SUM(cost_usd) as cost,
        SUM(api_calls) as calls,
        SUM(input_tokens) as inputTokens,
        SUM(output_tokens) as outputTokens
      FROM burn_turns
      WHERE ${where}
      GROUP BY model
      ORDER BY cost DESC
    `;
    return this.db.prepare(sql).all(...params) as ModelBreakdownRow[];
  }

  /** Breakdown by project, top 8. */
  getProjectBreakdown(opts: BurnQueryOpts): ProjectBreakdownRow[] {
    const { where, params } = this._buildWhere(opts);
    const sql = `
      SELECT
        project,
        SUM(cost_usd) as cost,
        COUNT(DISTINCT session_id) as sessions
      FROM burn_turns
      WHERE ${where}
      GROUP BY project
      ORDER BY cost DESC
      LIMIT 8
    `;
    return this.db.prepare(sql).all(...params) as ProjectBreakdownRow[];
  }

  /** Daily breakdown grouped by DATE(timestamp), with optional tz offset. */
  getDailyBreakdown(opts: BurnQueryOpts): DailyBreakdownRow[] {
    const { where, params } = this._buildWhere(opts);
    const modifier = this._resolveSqliteModifier(opts.tz);
    const sql = modifier
      ? `
        SELECT
          DATE(timestamp, ?) as date,
          SUM(cost_usd) as cost,
          SUM(api_calls) as calls
        FROM burn_turns
        WHERE ${where}
        GROUP BY DATE(timestamp, ?)
        ORDER BY date
      `
      : `
        SELECT
          DATE(timestamp) as date,
          SUM(cost_usd) as cost,
          SUM(api_calls) as calls
        FROM burn_turns
        WHERE ${where}
        GROUP BY DATE(timestamp)
        ORDER BY date
      `;
    const finalParams = modifier ? [modifier, ...params, modifier] : params;
    return this.db.prepare(sql).all(...finalParams) as DailyBreakdownRow[];
  }

  /** Whitelist-style resolver: only allow "+/-N hours" modifiers or IANA-style zone names. */
  private _resolveSqliteModifier(tz: string | undefined): string | null {
    if (!tz) return null;
    if (/^[+-]\d+(\.\d+)?\s+hours$/.test(tz)) return tz;
    if (/^[A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+){0,2}$/.test(tz)) {
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: tz, hour12: false,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        }).formatToParts(new Date());
        const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
        const now = Date.now();
        const wall = Date.UTC(
          get("year"), get("month") - 1, get("day"),
          get("hour") === 24 ? 0 : get("hour"), get("minute"), get("second"),
        );
        const offsetMin = Math.round((wall - now) / 60000);
        const hours = offsetMin / 60;
        const sign = hours >= 0 ? "+" : "-";
        return `${sign}${Math.abs(hours)} hours`;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Aggregate tool usage from tools_json column, top 10. */
  getToolBreakdown(opts: BurnQueryOpts): ToolBreakdownRow[] {
    return this._aggregateJsonColumn(opts, "tools_json", "tool", 10);
  }

  /** Aggregate MCP tool usage from mcp_tools_json column, top 10. */
  getMcpBreakdown(opts: BurnQueryOpts): ToolBreakdownRow[] {
    return this._aggregateJsonColumn(opts, "mcp_tools_json", "tool", 10);
  }

  /** Aggregate bash command usage from bash_cmds_json column, top 10. */
  getBashBreakdown(opts: BurnQueryOpts): BashBreakdownRow[] {
    return this._aggregateJsonColumn(opts, "bash_cmds_json", "cmd", 10) as any[];
  }

  /** Query rows in range, JSON.parse a column, aggregate counts, sort desc, return top N. */
  private _aggregateJsonColumn(
    opts: BurnQueryOpts,
    column: string,
    keyName: string,
    limit: number,
  ): { [key: string]: string | number }[] {
    const { where, params } = this._buildWhere(opts);
    const sql = `SELECT ${column} FROM burn_turns WHERE ${where}`;
    const rows = this.db.prepare(sql).all(...params) as any[];
    const counts = new Map<string, number>();
    for (const row of rows) {
      try {
        const items = JSON.parse(row[column]) as string[];
        for (const item of items) {
          counts.set(item, (counts.get(item) ?? 0) + 1);
        }
      } catch {
        // Skip malformed JSON
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, calls]) => ({ [keyName]: name, calls }));
  }

  /** Check which data dimensions have non-empty values in the date range. */
  getRuntimeCoverage(opts: BurnQueryOpts): {
    hasToolData: boolean;
    hasBashData: boolean;
    hasMcpData: boolean;
    hasOneShotData: boolean;
  } {
    const { where, params } = this._buildWhere(opts);
    const check = (condition: string): boolean => {
      const sql = `SELECT EXISTS(SELECT 1 FROM burn_turns WHERE ${where} AND ${condition}) as v`;
      const row = this.db.prepare(sql).get(...params) as any;
      return row.v === 1;
    };
    return {
      hasToolData: check("tools_json != '[]'"),
      hasBashData: check("bash_cmds_json != '[]'"),
      hasMcpData: check("mcp_tools_json != '[]'"),
      hasOneShotData: check("has_edits = 1"),
    };
  }

  /** Build WHERE clause and params array from query options. */
  private _buildWhere(opts: BurnQueryOpts): { where: string; params: any[] } {
    const conditions: string[] = ["1=1"];
    const params: any[] = [];

    if (opts.tenantId) {
      conditions.push("tenant_id = ?");
      params.push(opts.tenantId);
    }
    if (opts.since) {
      conditions.push("timestamp >= ?");
      params.push(opts.since);
    }
    if (opts.until) {
      conditions.push("timestamp <= ?");
      params.push(opts.until);
    }

    return { where: conditions.join(" AND "), params };
  }
}
