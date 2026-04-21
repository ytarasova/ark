import type { IDatabase } from "../database/index.js";
import type { Message, MessageRole, MessageType } from "../../types/index.js";
import { now } from "../util/time.js";

// -- Row type (read stored as integer 0/1) --------------------------------

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  type: string;
  read: number;
  created_at: string;
}

// -- Helpers --------------------------------------------------------------

function rowToMessage(row: MessageRow): Message {
  return {
    ...row,
    role: row.role as MessageRole,
    type: row.type as MessageType,
    read: !!row.read,
  };
}

// -- Repository -----------------------------------------------------------

export class MessageRepository {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }
  getTenant(): string {
    return this.tenantId;
  }

  async send(sessionId: string, role: MessageRole, content: string, type?: MessageType): Promise<Message> {
    const ts = now();
    await this.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, type, read, tenant_id, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      )
      .run(sessionId, role, content, type ?? "text", this.tenantId, ts);
    const row = (await this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT 1")
      .get(sessionId, this.tenantId)) as MessageRow;
    return rowToMessage(row);
  }

  async list(sessionId: string, opts?: { limit?: number; unreadOnly?: boolean }): Promise<Message[]> {
    let sql = "SELECT * FROM messages WHERE session_id = ? AND tenant_id = ?";
    const params: any[] = [sessionId, this.tenantId];

    if (opts?.unreadOnly) {
      sql += " AND read = 0";
    }

    sql += " ORDER BY id DESC LIMIT ?";
    params.push(opts?.limit ?? 50);

    const rows = (await this.db.prepare(sql).all(...params)) as MessageRow[];
    return rows.reverse().map(rowToMessage);
  }

  async markRead(sessionId: string): Promise<void> {
    await this.db
      .prepare("UPDATE messages SET read = 1 WHERE session_id = ? AND tenant_id = ? AND read = 0")
      .run(sessionId, this.tenantId);
  }

  async unreadCount(sessionId: string): Promise<number> {
    const row = (await this.db
      .prepare(
        "SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND tenant_id = ? AND role = 'agent' AND read = 0",
      )
      .get(sessionId, this.tenantId)) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** Return unread counts for all sessions that have at least one unread agent message. */
  async unreadCounts(): Promise<Record<string, number>> {
    const rows = (await this.db
      .prepare(
        "SELECT session_id, COUNT(*) as count FROM messages WHERE tenant_id = ? AND role = 'agent' AND read = 0 GROUP BY session_id",
      )
      .all(this.tenantId)) as { session_id: string; count: number }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.session_id] = row.count;
    }
    return result;
  }
}
