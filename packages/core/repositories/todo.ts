import type { IDatabase } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { now } from "../util/time.js";

export interface Todo {
  id: number;
  session_id: string;
  content: string;
  done: boolean;
  created_at: string;
}

type DrizzleSelectTodo = {
  id: number;
  sessionId: string;
  content: string;
  done: number;
  tenantId: string;
  createdAt: string;
};

function toTodo(row: DrizzleSelectTodo): Todo {
  return {
    id: row.id,
    session_id: row.sessionId,
    content: row.content,
    done: !!row.done,
    created_at: row.createdAt,
  };
}

export class TodoRepository {
  private tenantId: string = "default";
  private _d: DrizzleClient | null = null;

  constructor(private db: IDatabase) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }
  getTenant(): string {
    return this.tenantId;
  }

  async add(sessionId: string, content: string): Promise<Todo> {
    const ts = now();
    const d = this.d();
    await (d.db as any).insert(d.schema.todos).values({
      sessionId,
      content,
      done: 0 as any,
      tenantId: this.tenantId,
      createdAt: ts,
    });
    const t = d.schema.todos;
    const rows = await (d.db as any)
      .select()
      .from(t)
      .where(and(eq(t.sessionId, sessionId), eq(t.tenantId, this.tenantId)))
      .orderBy(desc(t.id))
      .limit(1);
    return toTodo((rows as DrizzleSelectTodo[])[0]);
  }

  async list(sessionId: string): Promise<Todo[]> {
    const d = this.d();
    const t = d.schema.todos;
    const rows = await (d.db as any)
      .select()
      .from(t)
      .where(and(eq(t.sessionId, sessionId), eq(t.tenantId, this.tenantId)))
      .orderBy(asc(t.id));
    return (rows as DrizzleSelectTodo[]).map(toTodo);
  }

  async toggle(id: number): Promise<Todo | null> {
    const d = this.d();
    const t = d.schema.todos;
    const rows = await (d.db as any)
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.tenantId, this.tenantId)))
      .limit(1);
    const row = (rows as DrizzleSelectTodo[])[0];
    if (!row) return null;
    const newDone = row.done ? 0 : 1;
    await (d.db as any)
      .update(t)
      .set({ done: newDone as any })
      .where(and(eq(t.id, id), eq(t.tenantId, this.tenantId)));
    return toTodo({ ...row, done: newDone });
  }

  async delete(id: number): Promise<boolean> {
    const d = this.d();
    const t = d.schema.todos;
    const res = await (d.db as any).delete(t).where(and(eq(t.id, id), eq(t.tenantId, this.tenantId)));
    return extractChangesLocal(res) > 0;
  }

  async allDone(sessionId: string): Promise<boolean> {
    const d = this.d();
    const t = d.schema.todos;
    const rows = await (d.db as any)
      .select({ count: sql<number>`COUNT(*)` })
      .from(t)
      .where(and(eq(t.sessionId, sessionId), eq(t.tenantId, this.tenantId), eq(t.done, 0 as any)));
    const row = (rows as Array<{ count: number | string }>)[0];
    return Number(row?.count ?? 0) === 0;
  }

  async deleteForSession(sessionId: string): Promise<void> {
    const d = this.d();
    const t = d.schema.todos;
    await (d.db as any).delete(t).where(and(eq(t.sessionId, sessionId), eq(t.tenantId, this.tenantId)));
  }
}

function extractChangesLocal(res: unknown): number {
  if (!res || typeof res !== "object") return 0;
  const r = res as { changes?: number; rowCount?: number; count?: number };
  if (typeof r.changes === "number") return r.changes;
  if (typeof r.rowCount === "number") return r.rowCount;
  if (typeof r.count === "number") return r.count;
  return 0;
}
