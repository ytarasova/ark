# Supporting Rohit's and Abhimanyu's flows in Ark -- 2026-04-18

> **Update 2026-04-18 (later in day, commit b9356da):** codebase-memory-mcp now vendored and auto-injected into every session's `.mcp.json`. This means BOTH Rohit's and Abhimanyu's agents (when running under Ark) automatically get 14 additional code-intelligence tools (`search_graph`, `trace_path`, `get_architecture`, `search_code`, `manage_adr`, etc.) on top of what their recipes declare. The 4 of 5 Sage-KB equivalents discussed in §7 are now covered by codebase-memory-mcp's tool set (modulo `kb_status` which has no direct analog). Cross-repo queries still need Camp 11.
---

> **Status:** deep-dive spec. No code changes. Companion to `2026-04-18-REQUIREMENTS_RECONCILIATION.md`.
> **Artifacts inspected on disk:**
>
> - `/tmp/goose-flow-compare/` -- full clone of `abhimanyu-rathore-paytm/goose-flow` (api/, web/, config/setup-goose/recipes, docs/)
> - `~/Downloads/islc-{orchestrate,ticket-intake,plan,audit,execute,verify,close,retro,ideate}.yaml` -- 9 ISLC recipe YAMLs (Abhimanyu)
> - `~/Downloads/PAI-31080-goose-recipe.yaml` -- 1375 lines, 72 steps (Rohit / Sage)
> - `~/Downloads/infra-clean.zip`, `~/Downloads/seed.zip` -- Rohit's dev-env topology

## 1. The two flows are structurally different Goose recipes

Both use the Goose Recipe YAML format. **The schemas diverge in which optional sections they populate.**

| Dimension | Abhimanyu (ISLC) | Rohit (Sage/PAI-31080) |
|---|---|---|
| Authoring | Hand-written, reusable | Machine-generated upstream by Sage from Jira ticket |
| Size | 9 files, ~150 lines each | 1 file, 1375 lines, 72 steps |
| Execution model | Narrative `prompt` + dynamic sub-recipe delegation | Structured `steps[]` array executed linearly |
| Parameterization | `parameters[]` with `jira_key`, `auto`, `from_stage` | No `parameters[]` -- the recipe IS the ticket |
| Orchestration | Master recipe delegates via `goose` tool at runtime | All steps pre-expanded, no delegation |
| MCPs used | `mcp__Atlassian__*`, `mcp__bitbucket__*`, `mcp__figma-remote-mcp__*` | `sage-kb` (kb_search/kb_graph/kb_blast_radius/kb_status) |
| State pattern | `.workflow/<jira-key>/state.json` + `subtasks.json` + `plan.md` + `tasks/<sub-task-key>/` | Implicit -- Sage owns upstream state; Ark session is the execution trace |
| Resumption | `from_stage` parameter + state.json checkpoint | TBD (presumably step index) |
| Gates | Between-stage `AskUserQuestion` (unless `auto: true`) | None explicit -- all steps run to completion |
| TDD cadence | Recipe-author choice | Strict write_tests → implement → verify per file |
| Repos touched | 1 (whatever `jira_key` maps to) | 3 (pi-event-registry, pi-action-executor, pi-risk-intelligence-centre-ui) |
| Feature flags | `.workflow/config.json` (`islc.enablePlanAudit`, `enableRetrospective`) | None |
| Extensions | `developer` (builtin) | `sage-kb` (single custom MCP) |

Both are legitimate Goose recipes. **Ark should run both, not pick one.**

## 2. Goose Recipe schema Ark needs to understand

From reading Abhimanyu's master (`islc-orchestrate.yaml`) + one sub-recipe (`islc-ticket-intake.yaml`) + Rohit's (`PAI-31080-goose-recipe.yaml`):

```yaml
version: 1.0.0                      # Goose Recipe API version
title: <string>
description: <string>

parameters:                         # optional -- Abhimanyu uses, Rohit does not
  - key: jira_key
    input_type: string              # string | boolean | integer
    requirement: required           # required | optional
    description: <string>
    default: <string>               # when optional

prompt: |                           # EITHER prompt (narrative) ...
  <Jinja-templated instructions -- {{param_name}} substitution>
  <Explicit MCP tool usage rules>
  <Step sequence the model follows>

steps:                              # ... OR steps (structured list) -- mutually exclusive with prompt
  - name: <step title>
    command: write_tests|implement|verify|<custom>
    args:
      repo: <repo-name>
      branch: <branch-name>
      files: [<path>, ...]
      criteria: [<BDD line>, ...]   # for write_tests
      prompt: <multiline implementation instructions>  # for implement
      validation: <shell command string>  # for verify

extensions:                         # MCP extensions (two forms)
  # Form A (Abhimanyu): list of named builtin/stdio
  - name: developer
    type: builtin
  # Form B (Rohit): map of name → config
  sage-kb:
    type: mcp
    url: http://localhost:8300/sage/mcp
    tools: [kb_search, kb_graph, ...]

response:                           # optional -- structured output schema
  type: json_schema
  properties: { ... }
```

## 3. What Ark already supports (verified in code)

**`packages/core/executors/goose.ts:53-89` -- `buildGooseCommand`:**

```ts
// Recipe delivery takes precedence over text delivery
if (opts.agent.recipe) {
  args.push("--recipe", opts.agent.recipe);
  for (const subRecipe of opts.agent.sub_recipes ?? []) {
    args.push("--sub-recipe", subRecipe);
  }
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    args.push("--params", `${k}=${v}`);
  }
}
```

**Session template params passed today** (`goose.ts:127-133`):

```ts
const recipeParams: Record<string, string> = {
  ticket: session.ticket ?? "",
  summary: session.summary ?? "",
  workdir: effectiveWorkdir,
  repo: session.repo ?? "",
  branch: session.branch ?? "",
};
```

**Other Ark capabilities already wired for Goose:**
- `--with-extension` wires Ark's channel MCP into Goose so `report()`/`send_to_agent()` works (packages/core/executors/goose.ts:64-67)
- Router env: `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` injected (`buildRouterEnv`, `goose.ts:160`)
- Model pinning via `--model`
- `--no-session` so Ark owns session state
- `--output-format stream-json` (unparsed today -- this is a Camp 10 gap)
- Interactive mode (`-s` flag) when stage gate is manual

**Ark Recipe vs Goose Recipe:** these are different types. Ark's `RecipeDefinition` (`packages/core/agent/recipe.ts:38-51`) is a *session template* (picks flow + agent + compute + vars). Goose's Recipe is a *self-contained agent instruction bundle*. In Ark today, a Goose recipe is referenced by file path via `agent.recipe` -- not stored in `app.recipes`.

## 4. Gaps that prevent supporting both today

| Gap | Abhimanyu impact | Rohit impact | Effort |
|---|---|---|---|
| **Arbitrary user-provided recipe params at CLI dispatch** | `from_stage`, `auto`, `max_subtask_hours` cannot be passed; only the 5 session template vars | Rohit's recipe has no params, no impact | 0.5 day -- add `ark session start --param k=v` |
| **Ad-hoc recipe file dispatch** (no registration step) | Medium -- recipes reusable once installed | **High -- Sage output is ephemeral per ticket** | 0.5 day -- `ark session start --recipe-file /path/to/file.yaml` |
| **Goose recipe registry with 3-tier resolution** | Wants recipes in `~/.ark/recipes/goose/` or similar | N/A (ad-hoc) | 0.5 day |
| **Per-tenant MCP config** (Atlassian/Bitbucket/Figma/Sage-KB creds) | **High -- none of MCPs work without user creds** | **High -- sage-kb needs URL or token** | Camp 10 secrets vault (3-4 days) |
| **Goose recipe → Ark artifact echo** | `.workflow/<jira-key>/` lands in worktree naturally | Same | 0 -- already works via worktree |
| **Stream-json parser** (hook-like status from goose) | Goose stays "running" until exit; no sub-stage progress | Same | 1 day (Camp 10 item) |
| **Feature flags session-scoped** | `islc.enablePlanAudit` / `enableRetrospective` | None | 0.5 day (Camp 10 item) |
| **Multi-repo sessions** | Single-repo is fine (ticket maps to one repo) | **Blocker -- Rohit's recipe spans 3 repos** | Camp 11 (days) |
| **Running without Ark-registered agent** | Current path requires `agent.recipe` field on an agent YAML | Same | 0.5 day -- synthetic inline agent |
| **Sage-KB MCP in goose config** | N/A | User must add `sage-kb` to `~/.config/goose/config.yaml` or Ark injects | 0.5 day (Ark injects via `--with-extension` or goose config templating) |
| **Audit of goose extension conflicts** | Abhimanyu assumes figma-remote-mcp is globally configured | Rohit assumes sage-kb is globally configured | 0 -- both land in user's goose config |

## 5. Recommended integration model: **hybrid dispatch**

Three dispatch paths for Goose recipes, same underlying executor:

### Path A: Registered recipe (Abhimanyu's ISLC)

```bash
# One-time install:
cp ~/Downloads/islc-*.yaml ~/.ark/recipes/goose/

# Dispatch:
ark session start \
  --runtime goose \
  --recipe islc-orchestrate \
  --param jira_key=IN-1234 \
  --param auto=false \
  --param from_stage=plan
```

What Ark does: resolves `islc-orchestrate` from three-tier recipe store (project → user → builtin), calls `goose run --recipe <path> --params k=v...` through the existing executor.

**Requires:** new CLI flags on `ark session start`: `--runtime goose`, `--recipe <name>`, `--param k=v` (repeatable). `--runtime` and `--recipe` already exist as concepts (runtime via flows/agents, recipe via RecipeStore), but the surface for passing arbitrary params isn't there today. The goose executor already forwards `--params` to goose -- the plumbing is the CLI parser.

### Path B: Ad-hoc recipe file (Rohit's Sage)

```bash
# Sage generates the YAML upstream and the user hands it to Ark:
ark session start \
  --runtime goose \
  --recipe-file ~/Downloads/PAI-31080-goose-recipe.yaml \
  --repo pi-event-registry   # or omit + use recipe's first step.args.repo
```

What Ark does:
1. Read the file without registering it in RecipeStore
2. Create a synthetic inline agent (ephemeral agent with `recipe: <path>`)
3. Dispatch via existing goose executor (which already handles `--recipe <path>`)
4. Store the file path in `session.config.recipe_file` so `session attach` and resume work
5. For multi-repo recipes, detect repos from `steps[].args.repo` and set up sibling worktrees (requires Camp 11)

**Requires:** `--recipe-file` flag, synthetic inline agent construction, multi-repo detection.

### Path C: Web UI upload

Drop a Goose recipe YAML into the chat panel's file upload (once file upload lands -- see 2026-04-18-REQUIREMENTS_RECONCILIATION.md §2 sub-matrix). Web routes it to the same RPC as Path B.

## 6. Concrete deltas to land both paths

Ordered by dependency. No code written in this session.

| # | Change | File(s) | LOC | Enables |
|---|---|---|---|---|
| 1 | `--param k=v` (repeatable) flag on `ark session start` | `packages/cli/commands/session/start.ts` | ~30 | Path A param passing |
| 2 | Route CLI `--param` values into goose executor's `recipeParams` (merge with the 5 template vars) | `packages/core/services/session-orchestration.ts` (dispatch path) | ~20 | Path A param passing |
| 3 | `--recipe-file <path>` flag; validate path exists + is YAML | `packages/cli/commands/session/start.ts` | ~20 | Path B entry |
| 4 | Synthetic inline agent constructor when `--recipe-file` is set | `packages/core/agent/agent.ts` | ~40 | Path B dispatch |
| 5 | Persist `recipe_file` on session config for resume/attach | `packages/core/repositories/session.ts` (whitelist column) | ~5 | Path B resume |
| 6 | Web UI: recipe-file upload button in ChatPanel + new session wizard | `packages/web/src/components/ChatPanel.tsx`, `SessionDetail.tsx`, server handler | ~200 | Path C |
| 7 | Multi-repo detection from `steps[].args.repo` (Rohit spans 3 repos) | `packages/core/agent/recipe.ts` (new Goose-recipe YAML inspector) | ~80 | Path B for multi-repo |
| 8 | Session-scoped feature flags (`session.config.feature_flags`) surfaced to goose via env or params | `session.ts`, goose executor | ~40 | Abhimanyu's `islc.enablePlanAudit` gate |
| 9 | Goose stream-json parser → status poller (existing Camp 10 item) | `packages/core/infra/status-poller.ts`, new parser file | ~150 | Sub-stage progress for both paths |
| 10 | Three-tier `~/.ark/recipes/goose/` resolution alongside Ark-native recipes | `packages/core/stores/recipe-store.ts` (or new `goose-recipe-store.ts`) | ~80 | Path A governance |

**Minimum viable slice** (just to unblock Rohit's integration): items 1-5 + 7 = ~135 LOC in ~1-2 days.

**Nothing on this list changes existing Ark behavior.** Every item is additive.

## 7. MCP credentials -- the actual sharp edge

Neither Abhimanyu's nor Rohit's recipes work out-of-the-box on a fresh machine because the MCPs they use require user-scoped credentials.

| Recipe | MCP | Cred needed | How it's supplied today |
|---|---|---|---|
| Abhimanyu | `mcp__Atlassian__*` | Atlassian API token + email | User edits `~/.config/goose/config.yaml` |
| Abhimanyu | `mcp__bitbucket__*` | Bitbucket app password | Same |
| Abhimanyu | `mcp__figma-remote-mcp__*` | Figma OAuth token | Same |
| Rohit | `sage-kb` | Either unauth (local http://localhost:8300) or Sage auth token | `~/.config/goose/config.yaml` |

**This is the Camp 10 secrets-vault requirement stated as a concrete blocker.** Until there is a per-user vault in Ark:

- Users still configure their goose MCPs manually via `~/.config/goose/config.yaml`
- Ark does not inject Atlassian/Bitbucket/Figma/Sage-KB creds -- it just launches goose
- `goose-flow`'s `--env-file` pattern (Camp 10 item) is how Abhimanyu solved this in his own harness: a `0700` env-file under `<chatStateDir>/_envfiles/<chat>.env` + `--env-file` on the goose child process

**Short-term for the pilot:** document that users must configure their goose MCPs themselves before the first dispatch. Abhimanyu has already shared his `~/.mcp.json` in the Slack thread as a starting template.

**Long-term:** Camp 10 secrets vault + `env_keys` declarative MCP lookup (both tasks already scoped, ~5-6 days combined).

## 8. How Ark's existing features map to what Abhimanyu built in goose-flow

goose-flow is a complete container-per-chat platform around goose. Ark overlaps on most of it. Quick mapping:

| goose-flow concern | goose-flow impl | Ark equivalent (today) | Status |
|---|---|---|---|
| Web UI with chat | React @ `web/` | packages/web | ✅ both have it |
| API server | Fastify @ `api/` | packages/server (JSON-RPC) | ✅ both have it |
| Goose session per chat | `ContainerRuntime` in `api/src/acp/` with Docker container per chat | Ark compute providers + session per worktree | ✅ Ark has equivalent + 10 more providers |
| Per-chat named volume for goose `sessions.db` | `gf-chat-<id>` named volume | Ark's stage isolation clears `claude_session_id`; goose uses `--no-session` | 🟡 different model (Ark avoids goose session DB entirely) |
| MCP extension config | `config/setup-goose/config.yaml` edited per chat | Ark injects via `--with-extension` + user's goose config | 🟡 Ark doesn't template goose config per-session |
| Secrets DB (SQLite `secrets` table) | `api/src/db/` + `env_keys` resolver | Camp 10 -- not started | ❌ gap |
| `--env-file` pattern | `<chatStateDir>/_envfiles/<chat>.env` | Ark passes env via shell, not env-file | 🟡 ROADMAP Camp 10 item |
| Feature flags | `.workflow/config.json` read at stage entry | Session-level featureFlags -- not started | ❌ gap |
| Stream-json parser (goose event framing) | `api/src/acp/framing.ts` | Ark sets flag, doesn't parse | ❌ ROADMAP Camp 10 item |
| ACP protocol | Used via `goose acp` | Ark doesn't speak ACP yet | 📍 Layer 10a on ROADMAP |
| LiteLLM sidecar | `litellm/` dir | Ark's router + TensorZero; LiteLLM is one provider route we haven't added | 🟡 Camp 10 item |
| 9 ISLC recipes | `config/setup-goose/recipes/` | Not copied in | 📍 Camp 10 item "Port the 9 ISLC recipes + jira-planner" |
| Traefik dynamic DNS | Dev-env plan doc in `docs/` | Not in Ark | 📍 Camp 10 item |

**Ark is broader but less polished on the goose-specific axes.** The Camp 10 items in `docs/ROADMAP.md` (lines 575-587) are specifically the goose-flow patterns worth porting.

## 9. Dispatch scenarios the two owners will actually run

### Abhimanyu's daily loop (ISLC)

```bash
# Start from ticket intake -- no auto (pause-for-approval between stages)
ark session start \
  --runtime goose \
  --recipe islc-orchestrate \
  --param jira_key=IN-1234
# ... user approves stage 0 → stage 1 dispatches ...
# ... user says "retry" at stage 2 → Ark re-dispatches with same state ...

# Resume later from where it stopped
ark session resume <session-id>

# Or explicitly skip to a stage
ark session start \
  --runtime goose \
  --recipe islc-orchestrate \
  --param jira_key=IN-1234 \
  --param from_stage=verify
```

### Rohit's Sage-driven loop

```bash
# Sage produces PAI-31080-goose-recipe.yaml upstream
# Ark consumes it ad-hoc:
ark session start \
  --runtime goose \
  --recipe-file ~/Downloads/PAI-31080-goose-recipe.yaml
# Ark detects 3 repos → Camp 11 multi-repo worktree layout
# Goose executes the 72 steps linearly
# Ark tracks progress via stream-json parser (Camp 10)
```

Both paths converge on the same goose executor. The new surface is:
- `--param k=v` (Path A)
- `--recipe-file <path>` (Path B)
- Multi-repo handling (Camp 11) -- only Path B needs it for Rohit's case
- MCP creds flow (Camp 10) -- both paths need it in production

## 10. What needs a decision before building

1. **Three-tier recipe resolution for Goose recipes** -- do we add a dedicated `~/.ark/recipes/goose/` directory, or just let users pass `--recipe-file` and not register anything? My read: register Abhimanyu's (reused every ticket), ad-hoc Rohit's (unique per ticket).
2. **Multi-repo for Rohit is a hard prerequisite.** Camp 11 (single-repo → `repos[]`) is the integration's critical path. Without it, Rohit's recipe either fails or needs to be split into 3 separate ark sessions.
3. **Gate between stages** -- Abhimanyu uses `AskUserQuestion`. Ark can honor this natively because goose handles the `AskUserQuestion` internally. But if we want the gate surfaced in Ark's web UI (not just in goose's console), we need either: (a) goose event parsing (Camp 10), or (b) an Ark-side wrapper that converts Abhimanyu's master recipe to an Ark flow with manual gates.
4. **Secrets-vault urgency** -- both pilots will hit the MCP-cred wall on day 1. This should jump priority in Camp 10.
5. **Should Ark ship sage-kb equivalence?** Rohit's recipe uses sage-kb for 5 read-only graph queries. Ark has 4/5 equivalents. Short-term: let goose call sage-kb directly (they're in the same datacenter). Long-term: bridge sage-kb ↔ Ark knowledge MCP so ark-native flows can use the same queries without goose.
6. **Response schema / structured output** -- Abhimanyu's sub-recipes return JSON (`{ sanity, spec_path, open_questions_count, stage, status }`). Ark's channel `report()` takes a similar shape. Decide: do we translate between them, or let goose own the return contract and Ark just records the stdout?

## 11. Recommended next steps (for decision)

| # | Action | Effort | Outcome |
|---|---|---|---|
| 1 | Install Abhimanyu's 9 ISLC recipes at `~/.ark/recipes/goose/` and prove Path A works end-to-end against one IN-* ticket | 0.5 day | Unblock Abhimanyu dogfooding |
| 2 | Add `--param k=v` to `ark session start` + propagate into goose executor's `recipeParams` | 0.5 day | Path A complete |
| 3 | Add `--recipe-file <path>` + synthetic inline agent | 0.5 day | Path B minimum for single-repo Sage plans |
| 4 | Multi-repo detection in recipe-file path + Camp 11 atomicity start | 3-5 days | Path B for Rohit's 3-repo PAI-31080 |
| 5 | Secrets vault thin slice: env-file injection from per-user encrypted store | 3-4 days | Both paths usable without manual goose config editing |
| 6 | Stream-json parser → status poller | 1 day | Sub-stage progress visible in Ark |
| 7 | Feature-flag session config (`islc.enablePlanAudit` etc.) | 0.5 day | Abhimanyu's optional stages work |

**~10 days of work total to fully support both flows through Ark.** Items 1-3 unblock the dogfood cases in <2 days; items 4-7 are the productionization layer.

## 12. What I did NOT verify in this pass

- Abhimanyu's 4 unread ISLC sub-recipes (audit, close, execute, verify, retro, ideate) -- only read orchestrate + ticket-intake + plan + top of execute. They likely follow the same shape.
- Actual recipe execution -- no test run of either flow through Ark today.
- Whether Abhimanyu's recipes assume specific goose version / MCP version beyond what's in the recipe `extensions:` block.
- Whether Rohit's `sage-kb` MCP at `http://localhost:8300/sage/mcp` is reachable from Ark's docker compute without additional networking.
- Whether there are newer versions of either recipe set than what I have on disk.

Verification of any of the above requires a real dispatch attempt.
