# Plan: One-line note in docs/architecture.md about arkd client/server/common split

## Summary

The recent arkd refactor (commits `34d39133`..`f0311621`) split the package into three barrel-only subdirectories -- `client/`, `server/`, `common/` -- with package.json sub-path exports and an ESLint `no-restricted-imports` boundary rule. `docs/architecture.md` still describes arkd as a "Single binary (`packages/arkd/server.ts`, ~800 lines)" in section 4.1, which is now wrong. This plan adds a one-line note in section 4.1 that records the new layout so future readers don't go hunting for the old flat file.

## Files to modify/create

| File | Change |
|------|--------|
| `docs/architecture.md` | Edit section 4.1 line 461: replace the stale "Single binary" fragment with a one-line note describing the `client/` + `server/` + `common/` split, sub-path exports, and ESLint boundary rule. |

No other files. No new files.

## Implementation steps

1. Open `docs/architecture.md` and locate the paragraph at line 461 (under `### 4.1 What it is`):

   ```
   A stateless HTTP server that runs on every compute target on port 19300. Single binary (`packages/arkd/server.ts`, ~800 lines) that exposes agent lifecycle, file ops, exec, metrics, channel relay, and codegraph indexing over HTTP.
   ```

2. Replace the fragment `Single binary (\`packages/arkd/server.ts\`, ~800 lines)` with a one-line factual note. Proposed wording:

   > Code is split into `packages/arkd/{client,server,common}/` -- consumers import only via the sub-path barrels (`@ark/arkd/client`, `@ark/arkd/server`, `@ark/arkd/common`); an ESLint `no-restricted-imports` rule blocks cross-imports between layers and reaching past barrels.

   Final paragraph after the edit (one paragraph, three sentences):

   > A stateless HTTP server that runs on every compute target on port 19300. Code is split into `packages/arkd/{client,server,common}/` -- consumers import only via the sub-path barrels (`@ark/arkd/client`, `@ark/arkd/server`, `@ark/arkd/common`); an ESLint `no-restricted-imports` rule blocks cross-imports between layers and reaching past barrels. It exposes agent lifecycle, file ops, exec, metrics, channel relay, and codegraph indexing over HTTP.

3. Save the file. No other doc updates -- the deeper section 4.x already documents endpoints/auth/etc. correctly.

4. Run `make format` (Prettier) and verify no other files changed. Markdown-only edit so lint is unaffected.

5. `git add docs/architecture.md && git commit -m "docs(architecture): note arkd client/server/common split + ESLint boundary"`.

## Testing strategy

- Run `make format` -- expect zero diff outside `docs/architecture.md`. The new sentence stays on one line, matching the line it replaces.
- Run `make lint` -- expect zero warnings. The ESLint boundary rule the note describes lives in `eslint.config.js`, so `make lint` passing confirms the rule the doc references is real.
- Visual inspection: section 4.1 should still read coherently with section 4.2 ("Why it exists") and section 4.3 ("What it runs"). No section headings move.
- No code path changes -- skip `make test`.

## Risk assessment

- **Scope creep risk:** the rest of section 4 still has minor staleness (e.g. "Single binary" framing carries over). Resist the urge to rewrite the whole section -- the task is one line. Leave any broader rewrite for a separate PR.
- **Wording drift:** keep the package alias names as they appear in `packages/arkd/package.json` (`./client`, `./server`, `./common`). Do not invent path forms (e.g. `arkd/client/client.ts`) that the ESLint rule actually disallows when imported by consumers.
- **Markdown formatting:** surrounding paragraphs use backticks around paths; preserve that style. No em dashes (CLAUDE.md rule); use `--`.
- **Breaking changes:** none. Documentation only.
- **Migration concerns:** none.

## Open questions

- Truncated task title (`add-a-one-line-note-to-docs-architecture-md-mentioning-that-`) -- assumed the "that-" continuation refers to the just-landed arkd client/server/common split, since (a) `docs/architecture.md` is the only architecture doc that still names `packages/arkd/server.ts` as a single file, and (b) the last ~15 commits on the branch are exclusively that refactor. If the intended note is about something else (e.g. the legacy session/flow engine being frozen pending Temporal, or the conductor port being hardcoded), the implementer should redirect with a fresh one-liner in the same location and discard the wording above.
- Section placement -- 4.1 is the natural spot. If a reviewer prefers a "Layout" subsection, splitting it out under `### 4.1.1 Layout` is a small cost. Defaulting to in-line, since the task asked for a one-line note.
