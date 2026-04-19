/**
 * Template variable substitution -- shared by agents and flows.
 * Replaces {variable} placeholders with session data.
 *
 * Dotted keys are supported for nested lookups into session.config.inputs:
 *   {inputs.files.recipe}   -> vars["inputs.files.recipe"]
 *   {inputs.params.jira}    -> vars["inputs.params.jira"]
 *
 * Keys that are not resolvable are preserved verbatim so downstream
 * consumers (goose, claude) see unchanged placeholders.
 */

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g;

/** Substitute {variable} placeholders. Unknown vars preserved as-is. */
export function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, key) => vars[key] ?? `{${key}}`);
}

/** Flatten an arbitrarily nested object into a dotted-key string map. */
function flatten(prefix: string, value: unknown, out: Record<string, string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(prefix ? `${prefix}.${k}` : k, v, out);
    }
    return;
  }
  out[prefix] = String(value);
}

/**
 * Build the standard variable map from a session object.
 *
 * Session-level fields (ticket, summary, repo, ...) are exposed flat.
 * Per-session input bags live at `session.config.inputs` and are flattened
 * into the `inputs.files.*` / `inputs.params.*` namespace so any template
 * consumer can reference them without bespoke plumbing.
 */
export function buildSessionVars(session: Record<string, unknown>): Record<string, string> {
  const vars: Record<string, string> = {
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

  const config = session.config as Record<string, unknown> | undefined;
  const inputs = config?.inputs;
  if (inputs && typeof inputs === "object") {
    flatten("inputs", inputs, vars);
  }

  return vars;
}
