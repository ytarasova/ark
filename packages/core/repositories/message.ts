import type { IDatabase } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Message, MessageRole, MessageType } from "../../types/index.js";
import { now } from "../util/time.js";

// -- Row type (read stored as integer 0/1) --------------------------------

type DrizzleSelectMessage = {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  type: string;
  read: number;
  tenantId: string;
  createdAt: string;
};

function rowToMessage(row: DrizzleSelectMessage): Message {
  return {
    id: row.id,
    session_id: row.sessionId,
    role: row.role as MessageRole,
    content: row.content,
    type: row.type as MessageType,
    read: !!row.read,
    created_at: row.createdAt,
  };
}

// -- Repository -----------------------------------------------------------

export class MessageRepository {
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

  async send(sessionId: string, role: MessageRole, content: string, type?: MessageType): Promise<Message> {
    const ts = now();
    const d = this.d();
    await (d.db as any).insert(d.schema.messages).values({
      sessionId,
      role,
      content,
      type: type ?? "text",
      read: 0 as any,
      tenantId: this.tenantId,
      createdAt: ts,
    });
    const m = d.schema.messages;
    const rows = await (d.db as any)
      .select()
      .from(m)
      .where(and(eq(m.sessionId, sessionId), eq(m.tenantId, this.tenantId)))
      .orderBy(desc(m.id))
      .limit(1);
    return rowToMessage((rows as DrizzleSelectMessage[])[0]);
  }

  async list(sessionId: string, opts?: { limit?: number; unreadOnly?: boolean }): Promise<Message[]> {
    const d = this.d();
    const m = d.schema.messages;
    const filters = [eq(m.sessionId, sessionId), eq(m.tenantId, this.tenantId)];
    if (opts?.unreadOnly) filters.push(eq(m.read, 0 as any));
    const rows = await (d.db as any)
      .select()
      .from(m)
      .where(and(...filters))
      .orderBy(desc(m.id))
      .limit(opts?.limit ?? 50);
    return (rows as DrizzleSelectMessage[]).reverse().map(rowToMessage);
  }

  async markRead(sessionId: string): Promise<void> {
    const d = this.d();
    const m = d.schema.messages;
    await (d.db as any)
      .update(m)
      .set({ read: 1 as any })
      .where(and(eq(m.sessionId, sessionId), eq(m.tenantId, this.tenantId), eq(m.read, 0 as any)));
  }

  async unreadCount(sessionId: string): Promise<number> {
    const d = this.d();
    const m = d.schema.messages;
    const rows = await (d.db as any)
      .select({ count: sql<number>`COUNT(*)` })
      .from(m)
      .where(and(eq(m.sessionId, sessionId), eq(m.tenantId, this.tenantId), eq(m.role, "agent"), eq(m.read, 0 as any)));
    const row = (rows as Array<{ count: number }>)[0];
    return Number(row?.count ?? 0);
  }

  /** Return unread counts for all sessions that have at least one unread agent message. */
  async unreadCounts(): Promise<Record<string, number>> {
    const d = this.d();
    const m = d.schema.messages;
    const rows = await (d.db as any)
      .select({ sessionId: m.sessionId, count: sql<number>`COUNT(*)` })
      .from(m)
      .where(and(eq(m.tenantId, this.tenantId), eq(m.role, "agent"), eq(m.read, 0 as any)))
      .groupBy(m.sessionId);
    const result: Record<string, number> = {};
    for (const row of rows as Array<{ sessionId: string; count: number | string }>) {
      result[row.sessionId] = Number(row.count);
    }
    return result;
  }
}

// Silence the unused-import warning if `asc` is stripped by a future edit:
void asc;
