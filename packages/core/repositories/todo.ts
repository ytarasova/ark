import type { IDatabase } from "../database/index.js";

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
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(tenantId: string): void { this.tenantId = tenantId; }
  getTenant(): string { return this.tenantId; }

  add(sessionId: string, content: string): Todo {
    const ts = now();
    this.db.prepare(
      "INSERT INTO todos (session_id, content, done, tenant_id, created_at) VALUES (?, ?, 0, ?, ?)"
    ).run(sessionId, content, this.tenantId, ts);
    const row = this.db.prepare(
      "SELECT * FROM todos WHERE session_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT 1"
    ).get(sessionId, this.tenantId) as TodoRow;
    return { ...row, done: !!row.done };
  }

  list(sessionId: string): Todo[] {
    const rows = this.db.prepare(
      "SELECT * FROM todos WHERE session_id = ? AND tenant_id = ? ORDER BY id ASC"
    ).all(sessionId, this.tenantId) as TodoRow[];
    return rows.map(r => ({ ...r, done: !!r.done }));
  }

  toggle(id: number): Todo | null {
    const row = this.db.prepare("SELECT * FROM todos WHERE id = ? AND tenant_id = ?").get(id, this.tenantId) as TodoRow | undefined;
    if (!row) return null;
    const newDone = row.done ? 0 : 1;
    this.db.prepare("UPDATE todos SET done = ? WHERE id = ? AND tenant_id = ?").run(newDone, id, this.tenantId);
    return { ...row, done: !!newDone };
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM todos WHERE id = ? AND tenant_id = ?").run(id, this.tenantId);
    return result.changes > 0;
  }

  allDone(sessionId: string): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM todos WHERE session_id = ? AND tenant_id = ? AND done = 0"
    ).get(sessionId, this.tenantId) as { count: number };
    return row.count === 0;
  }

  deleteForSession(sessionId: string): void {
    this.db.prepare("DELETE FROM todos WHERE session_id = ? AND tenant_id = ?").run(sessionId, this.tenantId);
  }
}
