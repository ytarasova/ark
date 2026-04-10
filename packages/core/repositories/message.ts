import type { IDatabase } from "../database.js";
import type { Message, MessageRole, MessageType } from "../../types/index.js";

// ── Row type (read stored as integer 0/1) ───────────────────────────────────

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  type: string;
  read: number;
  created_at: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function rowToMessage(row: MessageRow): Message {
  return {
    ...row,
    role: row.role as MessageRole,
    type: row.type as MessageType,
    read: !!row.read,
  };
}

// ── Repository ──────────────────────────────────────────────────────────────

export class MessageRepository {
  constructor(private db: IDatabase) {}

  send(sessionId: string, role: MessageRole, content: string, type?: MessageType): Message {
    const ts = now();
    this.db.prepare(
      "INSERT INTO messages (session_id, role, content, type, read, created_at) VALUES (?, ?, ?, ?, 0, ?)"
    ).run(sessionId, role, content, type ?? "text", ts);
    const row = this.db.prepare(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1"
    ).get(sessionId) as MessageRow;
    return rowToMessage(row);
  }

  list(sessionId: string, opts?: { limit?: number; unreadOnly?: boolean }): Message[] {
    let sql = "SELECT * FROM messages WHERE session_id = ?";
    const params: any[] = [sessionId];

    if (opts?.unreadOnly) {
      sql += " AND read = 0";
    }

    sql += " ORDER BY id DESC LIMIT ?";
    params.push(opts?.limit ?? 50);

    const rows = this.db.prepare(sql).all(...params) as MessageRow[];
    return rows.reverse().map(rowToMessage);
  }

  markRead(sessionId: string): void {
    this.db.prepare("UPDATE messages SET read = 1 WHERE session_id = ? AND read = 0").run(sessionId);
  }

  unreadCount(sessionId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND role = 'agent' AND read = 0"
    ).get(sessionId) as { count: number } | undefined;
    return row?.count ?? 0;
  }
}
