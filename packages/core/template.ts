/**
 * Template variable substitution -- shared by agents and flows.
 * Replaces `{variable}` and `{{variable}}` placeholders with session data.
 *
 * Brace forms accepted:
 *   {var}            legacy single-brace form
 *   {{var}}          double-brace form (used by the Web UI chip bar)
 *   {{ var }}        whitespace tolerant
 *
 * Dotted keys are supported for nested lookups into session.config.inputs:
 *   {inputs.files.recipe}    -> vars["inputs.files.recipe"]
 *   {inputs.params.jira}     -> vars["inputs.params.jira"]
 *
 * Short-namespace aliases resolve the Web UI chip keys without callers
 * having to know about the `inputs.` prefix:
 *   {{files.recipe}}         -> vars["inputs.files.recipe"] (if present)
 *   {{params.jira}}          -> vars["inputs.params.jira"]  (if present)
 *
 * Keys that are not resolvable are preserved verbatim (including the
 * original brace style) so downstream consumers (goose, claude) see
 * unchanged placeholders.
 */

// Match either {{ name }} (double brace, whitespace-tolerant) or {name}
// (single brace, no whitespace). Group 1 = double-brace key, group 2 =
// single-brace key. Keys may be dotted identifiers.
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}|\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g;

/** Resolve a key against vars, applying short-namespace aliases. */
function resolveKey(key: string, vars: Record<string, string>): string | undefined {
  if (key in vars) return vars[key];
  // Web UI chip bar inserts `files.X` / `params.X` -- alias to the
  // fully-qualified `inputs.files.X` / `inputs.params.X` bag.
  if (key.startsWith("files.") || key.startsWith("params.")) {
    const aliased = `inputs.${key}`;
    if (aliased in vars) return vars[aliased];
  }
  return undefined;
}

/** Substitute `{var}` / `{{var}}` placeholders. Unknown vars preserved as-is. */
export function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (match, doubleKey, singleKey) => {
    const key = doubleKey ?? singleKey;
    const value = resolveKey(key, vars);
    return value ?? match;
  });
}

/**
 * Return the list of placeholder keys in `template` that cannot be resolved
 * against `vars`. The short-namespace aliases are applied, so
 * `{{files.foo}}` is considered resolved when `inputs.files.foo` is set.
 * Each key appears once in the output, in the order it was first seen.
 */
export function unresolvedVars(template: string, vars: Record<string, string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const key = match[1] ?? match[2];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (resolveKey(key, vars) === undefined) out.push(key);
  }
  return out;
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
