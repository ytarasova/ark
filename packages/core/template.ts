/**
 * Template variable substitution — shared by agents and flows.
 * Replaces {variable} placeholders with session data.
 */

/** Substitute {variable} placeholders. Unknown vars preserved as-is. */
export function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/** Build the standard variable map from a session object. */
export function buildSessionVars(session: Record<string, unknown>): Record<string, string> {
  return {
    ticket: String(session.ticket ?? ""),
    summary: String(session.summary ?? ""),
    jira_key: String(session.ticket ?? ""),
    jira_summary: String(session.summary ?? ""),
    repo: String(session.repo ?? ""),
    branch: String(session.branch ?? ""),
    workdir: String(session.workdir ?? "."),
    track_id: String(session.id ?? ""),
    session_id: String(session.id ?? ""),
    stage: String(session.stage ?? ""),
    flow: String(session.flow ?? ""),
    agent: String(session.agent ?? ""),
    compute: String(session.compute_name ?? "local"),
  };
}
