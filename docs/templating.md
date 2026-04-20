# Templating

Ark's agent YAML, flow YAML, recipe YAML, and on-reject prompts use
**Nunjucks** (Jinja-for-JS) as the template engine. Everything that was a
"variable substitution" before is now a real Jinja template.

## Syntax

| Form                               | Meaning                                           |
| ---------------------------------- | ------------------------------------------------- |
| `{{ var }}`                        | output variable (whitespace optional)             |
| `{{ inputs.files.recipe }}`        | dotted lookup into session inputs                 |
| `{{ files.recipe }}`               | short-namespace alias for `inputs.files.recipe`   |
| `{{ branch \| default("main") }}`  | filter; `default` triggers when var is undefined  |
| `{% if ticket %}...{% endif %}`    | conditional                                       |
| `{% for k, v in inputs.params %}...{% endfor %}` | loop over nested object |
| `{% raw %}{{literal}}{% endraw %}` | escape Jinja syntax inside a literal block        |

## Supported variables

`buildSessionVars()` exposes the following flat keys for every session:

- `ticket`, `summary`, `repo`, `branch`, `workdir`
- `track_id`, `session_id`, `stage`, `flow`, `agent`, `compute`
- `jira_key` / `jira_summary` (back-compat aliases for `ticket` / `summary`)
- Everything under `session.config.inputs.*` flattened as
  `inputs.files.<role>`, `inputs.params.<key>`, etc.

## Short-namespace aliases

For convenience, `{{files.X}}` resolves to `{{inputs.files.X}}` when no
top-level `files.X` is defined. The same alias applies to `params`, `data`,
and any other top-level field under `inputs`. Use the long form if you need to
refer to a sub-path inside a filter argument or condition -- the short form is
Output-only.

```yaml
# Both work, both resolve to session.config.inputs.files.recipe
recipe: "{{ files.recipe }}"
recipe: "{{ inputs.files.recipe }}"
```

## Unknown variables

Unknown variables in Output positions (`{{foo}}`) are **preserved verbatim** --
the rendered output contains the literal `{{foo}}` text. This lets downstream
consumers (goose recipes, claude prompts) see untouched placeholders if
something in the session didn't resolve.

Unknown variables in conditional, loop, or filter-argument positions resolve
to `undefined` (falsy / empty), following standard Nunjucks semantics:

```jinja
{% if missing %}never renders{% endif %}
{{ missing | default("fallback") }}   -> "fallback"
```

## Migration note: {var} -> {{var}}

Ark historically used a hand-rolled `{var}` single-brace regex engine. All
builtin YAML (agents, flows, recipes) was migrated to `{{var}}` in one pass.

If you maintain a fork or user-space YAML, convert single-brace placeholders
to double-brace. The engine no longer recognises `{var}`: it's treated as
literal text.

Use `{% raw %}...{% endraw %}` if you literally need `{{...}}` in the output.

## API

```ts
import { substituteVars, buildSessionVars, unresolvedVars } from "@ark/core";

// Render a template
const out = substituteVars("Hello {{name}}", { name: "world" });

// Build the standard session variable map
const vars = buildSessionVars(session);

// Find variables referenced but not resolvable
const missing = unresolvedVars("{{files.bar}} {{ticket}}", { ticket: "X" });
// -> ["files.bar"]
```

All three functions go through Nunjucks's parser + renderer. Zero regex,
zero string substitution.
