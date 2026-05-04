# Plan: Sync CLAUDE.md and README.md with current project state

## 1. Summary

CLAUDE.md and README.md have drifted from the repo, and they contradict each other (test parallelism, `make dev` semantics). This plan is a surgical doc-only edit: fix stale counts, remove references to gone entities (`e2b`, `*-orchestration.ts` files), add what actually ships today (claude-agent runtime, `e2e` package, `claude-max` runtime in CLAUDE.md, `make format`/`dev-daemon`/`drift` in README, accurate flow/agent/recipe counts), and reconcile the two files so they agree.

No code or tests change. Scope is strictly the two root markdown files.

## 2. Files to modify/create

| File | Change |
|------|--------|
| `CLAUDE.md` | Fix packages list (add `e2e`), runtime list (4 -> 6; add `claude-agent` and `claude-max`; rename `claude` -> `claude-code`), compute providers (drop `e2b`, fix count), orchestration reference (drop `*-orchestration.ts` paths that no longer exist) |
| `README.md` | Fix feature-table runtime count (5 -> 6, add claude-agent), flow count (13 -> 22 or switch to summary), agents count (12 -> 13), recipes count (8 -> 10), fix `make dev` description (it's hot-reload, not TypeScript watch), fix test parallelism claim (parallel with `--concurrency 4`), fix `make desktop-build` -> `make build-desktop`, add `make format` + `make dev-daemon` + `make drift` to the dev table |

No new files. No deletions.

## 3. Implementation steps

Each step is an independent markdown edit; verify by re-reading the patched section and running the greps in section 4.

### Step 1 -- CLAUDE.md top description (line 3)

Change: `11 compute providers` -> accurate phrasing. Actual provider set under `packages/compute/` is local, docker (+ devcontainer subvariant), ec2 (arkd, arkd-docker, arkd-devcontainer, arkd-firecracker), firecracker, k8s, k8s-kata. No `e2b`. Rewrite to: `"with pluggable compute (local, Docker, DevContainer, Firecracker, EC2 via arkd, K8s, K8s+Kata)"`.

Also rewrite the runtime sentence: `Supports Claude Code, Codex, Gemini CLI, and Goose runtimes.` -> `Supports Claude Code, headless Claude Agent SDK, Claude Max, Codex, Gemini CLI, and Goose runtimes.`

### Step 2 -- CLAUDE.md Project Structure block (lines 30-48)

- Compute line: `11 providers (local, docker, devcontainer, firecracker, ec2-*, e2b, k8s, k8s-kata)` -> `providers (local, docker, devcontainer, firecracker, ec2-arkd-*, k8s, k8s-kata)` (drop `e2b`; drop hard count).
- Add a new line after `types/`: `e2e/     -> End-to-end tests (Playwright for web + desktop)`.
- Runtimes line: `claude, codex, gemini, goose` -> `claude-code, claude-agent, claude-max, codex, gemini, goose`.
- Flows line: existing `(autonomous-sdlc, quick, fan-out, etc.)` is accurate; leave untouched.
- Add one line for `mcp-configs/  -> MCP config stubs (Atlassian, GitHub, Linear, Figma)` since it is referenced in the README and exists at the repo root.

### Step 3 -- CLAUDE.md Key entry points (lines 52-57)

- `services/session.ts` line -- keep.
- `session-orchestration.ts` bullet (line 56) -- **delete entirely**. No such file exists. Replace with:
  > `services/session/` + `services/dispatch/` + `services/stage-advance/` -- orchestration subpackages. Every entry point takes `app: AppContext` as first arg.
- MCP tool count "27 tools" -- audit confirmed 27 tools across `packages/server/mcp/tools/*.ts`. Keep.

### Step 4 -- CLAUDE.md Orchestration note (line 59)

Current text: `packages/core/state/flow.ts + packages/core/services/*-orchestration.ts`. No file matching `*-orchestration.ts` exists. Replace with: `packages/core/state/flow.ts + the services subpackages under packages/core/services/{session,dispatch,stage-advance}/`. Keep the Temporal paragraph intact (verified `docs/temporal.md`, `docs/temporal-local-dev.md`, `make dev-temporal` all exist).

### Step 5 -- README.md Features table (lines 56-82)

Line 57 `Multi-Runtime Support | 5 runtimes (Claude, Claude Max subscription, Codex, Gemini, Goose) with runtime/role separation` -> `6 runtimes (Claude Code, headless Claude Agent SDK, Claude Max, Codex, Gemini, Goose) with runtime/role separation`.

No other feature rows need wording changes; all the described behaviors still ship.

### Step 6 -- README.md Architecture block (lines 85-123)

- Line 109 `agents/       12 agent definitions (...)` -> `13 agent definitions (...)` and append `goose-recipe-runner` to the enumerated list.
- Line 112 `runtimes/     5 runtime definitions (claude, claude-max, codex, gemini, goose)` -> `6 runtime definitions (claude-code, claude-agent, claude-max, codex, gemini, goose)`.
- Lines 113-115 `flows/        13 flow definitions (...)` -> replace enumerated list with summary to avoid monthly drift: `flows/        22 flow definitions under flows/definitions/ (autonomous-sdlc, quick, bare, autonomous, parallel, fan-out, dag-parallel, pr-review, islc/islc-quick, brainstorm, conditional, docs, goose-recipe, e2e-noop, ...) + per-recipe flows at the flows/ root`.
- Lines 118-119 `recipes/      8 recipe templates (quick-fix, feature-build, code-review, fix-bug, new-feature, ideate, islc, islc-quick)` -> `10 recipe templates (quick-fix, feature-build, code-review, fix-bug, new-feature, ideate, islc, islc-quick, self-dogfood, self-quick)`.

### Step 7 -- README.md Development block (lines 133-147)

Replace the command table:

```bash
make dev              # hot-reload: API (:8420) + Vite HMR (:5173) + auto-starts daemon
make dev-daemon       # hot-reload: server daemon (conductor + arkd + WS)
make test             # run all tests (parallel, --concurrency 4)
make test-file F=path # run a single test file
make format           # Prettier auto-fix (required before every commit)
make lint             # ESLint, zero warnings allowed
make web              # launch web dashboard
make desktop          # launch Electron desktop app
make build-desktop    # package Electron app for distribution
make drift            # drizzle-kit check (CI gate)
make clean            # remove build artifacts
make uninstall        # remove ark symlink
```

Also fix the trailing sentence (line 147): `Tests use bun:test. Always run via make test -- never call bun test directly (tests must run sequentially to avoid port collisions).` -> `Tests use bun:test. Always run via make test -- never call bun test directly. Tests run in parallel (--concurrency 4); each test boots a fresh AppContext.forTestAsync() with isolated ports + arkDir.`

### Step 8 -- Cross-file consistency audit

After edits, grep both files to confirm:
- `rg "e2b" CLAUDE.md README.md` -> 0 hits.
- `rg "session-orchestration" CLAUDE.md README.md` -> 0 hits.
- `rg "sequentially" README.md` -> 0 hits.
- `rg "13 flow definitions" README.md` -> 0 hits.
- Runtime count says 6 in both files; agent count 13; recipe count 10.
- No em dashes (U+2014): `rg $'—' CLAUDE.md README.md` -> 0 hits.

## 4. Testing strategy

Doc-only change -- there is no automated coverage for markdown content.

- Verification greps (must all be zero hits after edits):
  - `rg -c "e2b|session-orchestration|sequentially|13 flow definitions|8 recipe templates|12 agent definitions|5 runtime definitions|TypeScript watch" CLAUDE.md README.md`
  - `rg $'—' CLAUDE.md README.md`
- Positive-claim greps (must hit):
  - `rg -c "claude-agent" CLAUDE.md README.md` -> >=2 hits (one in each file).
  - `rg -c "22 flow definitions" README.md` -> 1 hit.
  - `rg -c "10 recipe templates" README.md` -> 1 hit.
  - `rg -c "13 agent definitions" README.md` -> 1 hit.
  - `rg -c "6 runtime definitions" README.md` -> 1 hit.
  - `rg -c "\\-\\-concurrency 4" README.md` -> >=1 hit.
- Link integrity: click-check every relative link in README.md. Audit already confirmed the target files exist; re-verify anchors. In particular, `CLAUDE.md#runtimes` resolves only if CLAUDE.md has a `## Runtimes` heading -- it does not today. Drop the anchor (link to bare `CLAUDE.md`) or add a heading. See Open Question 1.
- Run `make format` to confirm prettier does not touch the markdown (it shouldn't; the repo's prettier config does not format .md). If it does, accept the changes.
- Visual diff: render both files (GitHub preview or `glow`) and re-read the Features table and Architecture block for phrasing sanity.

## 5. Risk assessment

- **Low-blast-radius, doc-only.** No code paths, migrations, or CI gates touched beyond markdown.
- **Stale anchor link** -- README links to `CLAUDE.md#runtimes`, which does not exist as a heading. Either add the heading (mild scope creep) or strip the anchor. Recommended: strip.
- **Flow enumeration drift** -- the existing enumerated flow list was already out of date. Switching to a summary with "..." reduces future maintenance cost but means the count will drift again as flows are added. Acceptable because CLAUDE.md's summary approach in the Architecture block already sets that precedent.
- **Runtime naming tweak** -- changing `claude` to `claude-code` in the CLAUDE.md runtimes line matches the filename in `runtimes/claude-code.yaml`. Users who grep for the runtime name will find it. No behavioral impact.
- **Existing PLAN.md on disk** -- this repo root already had an unrelated PLAN.md (docs/guide.md update plan). Overwriting is destructive to that artifact. Low risk because PLAN.md at the root is a working artifact per the task conventions, not a source of truth. See Open Question 2.
- **No breaking changes**; all edits tighten and reconcile existing claims.

## 6. Open questions

1. **Anchor links in README.** Should the implementer (a) add a `## Runtimes` section to CLAUDE.md so `CLAUDE.md#runtimes` resolves, or (b) strip the `#runtimes` anchor and link to bare `CLAUDE.md`? Recommended (b) -- minimal scope, avoids adding a section that risks becoming stale itself.
2. **Overwrite of existing PLAN.md.** The repo root already contains an unrelated PLAN.md (docs/guide.md update). Task brief says "Write a PLAN.md in the repo root", so this plan overwrites it. Confirm that is acceptable, or move the old plan to `docs/plans/` first.
3. **Flow enumeration policy.** Enumerate all 22 flows (accurate but brittle), curate a top-10 (requires future care), or one-sentence summary with a pointer (lowest maintenance). Recommended: curated list ending in `...` as drafted in Step 6.
4. **Temporal mention in README.** CLAUDE.md documents the Temporal migration; README does not. Add a one-line mention, or leave Temporal as a developer-only concern? Recommended: leave README untouched -- do not surface in-flight internal migrations in user-facing docs.
