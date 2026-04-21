/**
 * TicketQuery -> Bitbucket Cloud BBQL.
 *
 * BBQL uses SQL-ish predicates joined with AND. Example:
 *   q=state="open" AND assignee.username="alice"
 *
 * BB Issues API doesn't have labels natively, so `TicketQuery.labels` is
 * best-effort: we match against `component.name`, `milestone.name`, and
 * `version.name` for label values prefixed with `component:` / `milestone:` /
 * `version:`. Plain labels are ignored.
 */

import type { TicketQuery, TicketStatusCategory } from "../../types.js";

type BbState = "new" | "open" | "resolved" | "on hold" | "invalid" | "duplicate" | "wontfix" | "closed";

const CATEGORY_STATES: Record<TicketStatusCategory, BbState[]> = {
  todo: ["new", "on hold"],
  in_progress: ["open"],
  done: ["resolved", "closed"],
  cancelled: ["invalid", "wontfix", "duplicate"],
};

export function buildBbql(q: TicketQuery): string {
  const clauses: string[] = [];

  if (q.statusCategories?.length) {
    const states = new Set<BbState>();
    for (const c of q.statusCategories) for (const s of CATEGORY_STATES[c]) states.add(s);
    if (states.size) {
      const list = [...states].map(quote).join(", ");
      clauses.push(`state IN (${list})`);
    }
  }

  for (const a of q.assigneeIds ?? []) clauses.push(`assignee.uuid=${quote(a)}`);
  for (const r of q.reporterIds ?? []) clauses.push(`reporter.uuid=${quote(r)}`);

  for (const l of q.labels ?? []) {
    const [scope, ...rest] = l.split(":");
    const value = rest.join(":");
    if (!value) continue;
    if (scope === "component") clauses.push(`component.name=${quote(value)}`);
    else if (scope === "milestone") clauses.push(`milestone.name=${quote(value)}`);
    else if (scope === "version") clauses.push(`version.name=${quote(value)}`);
    // Plain labels are not representable in BB issues; silently drop.
  }

  if (q.updatedSince) clauses.push(`updated_on >= ${quote(q.updatedSince)}`);
  if (q.text?.trim()) clauses.push(`title ~ ${quote(q.text.trim())}`);

  return clauses.join(" AND ");
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
