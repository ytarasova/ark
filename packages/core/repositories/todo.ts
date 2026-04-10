import type { IDatabase } from "../database.js";

function now(): string { return new Date().toISOString(); }

export interface Todo {
  id: number;
  session_id: string;
  content: string;
  done: boolean;
  created_at: string;
}

/** Raw row shape returned by bun:sqlite for the todos table. */
interface TodoRow {
  id: number;
  session_id: string;
  content: string;
  done: number;
  created_at: string;
}

export class TodoRepository {
  constructor(private db: IDatabase) {}

  add(sessionId: string, content: string): Todo {
    const ts = now();
    this.db.prepare(
      "INSERT INTO todos (session_id, content, done, created_at) VALUES (?, ?, 0, ?)"
    ).run(sessionId, content, ts);
    const row = this.db.prepare(
      "SELECT * FROM todos WHERE session_id = ? ORDER BY id DESC LIMIT 1"
    ).get(sessionId) as TodoRow;
    return { ...row, done: !!row.done };
  }

  list(sessionId: string): Todo[] {
    const rows = this.db.prepare(
      "SELECT * FROM todos WHERE session_id = ? ORDER BY id ASC"
    ).all(sessionId) as TodoRow[];
    return rows.map(r => ({ ...r, done: !!r.done }));
  }

  toggle(id: number): Todo | null {
    const row = this.db.prepare("SELECT * FROM todos WHERE id = ?").get(id) as TodoRow | undefined;
    if (!row) return null;
    const newDone = row.done ? 0 : 1;
    this.db.prepare("UPDATE todos SET done = ? WHERE id = ?").run(newDone, id);
    return { ...row, done: !!newDone };
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM todos WHERE id = ?").run(id);
    return result.changes > 0;
  }

  allDone(sessionId: string): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM todos WHERE session_id = ? AND done = 0"
    ).get(sessionId) as { count: number };
    return row.count === 0;
  }

  deleteForSession(sessionId: string): void {
    this.db.prepare("DELETE FROM todos WHERE session_id = ?").run(sessionId);
  }
}
