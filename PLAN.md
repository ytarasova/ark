# PLAN: One-line note in docs/architecture.md

## 1. Summary

The task name is truncated (`add-a-one-line-note-to-docs-architecture-md-mentioning-that-` --
the predicate after "that" is missing). The most plausible referent, given the recent five
`refactor(arkd): ...` commits on this branch finishing the arkd `client/` / `server/` /
`common/` separation, is the new arkd package layout: Section 4.1 of `docs/architecture.md`
still calls arkd a "Single binary (`packages/arkd/server.ts`, ~800 lines)" -- stale after
commits `c3b89eb9`, `f0311621`, `63889c7a`. This plan adds one sentence to that section to
record the split. No code, no tests.

## 2. Files to modify/create

- `docs/architecture.md` -- add one sentence to Section 4.1 noting that arkd is organized as
  `client/`, `server/`, `common/` sub-packages with an ESLint boundary rule, and bump the
  `Last updated:` line at top.
- `PLAN.md` -- this planning artifact (committed on this branch by the planner).

No new files, no code, no schema, no tests.

## 3. Implementation steps

These are independent and can each be verified standalone.

1. **Edit Section 4.1** of `docs/architecture.md` (lines 459-461):
   - Replace the "Single binary (`packages/arkd/server.ts`, ~800 lines)" wording with prose
     that reflects the current layout: server entry under `packages/arkd/server/`, typed
     `client/` for callers, shared `common/`, and an ESLint `no-restricted-imports` boundary
     preventing `client/` <-> `server/` cross-imports.
   - Keep the addition to one sentence; do not balloon the section. The task explicitly says
     "one-line note".
2. **Bump the `Last updated:` line** at `docs/architecture.md` line 4 to `2026-05-06`.
3. **Run `make format`** to apply Prettier to the Markdown file.
4. **Sanity-grep** for the now-stale phrase elsewhere in `docs/`:
   `grep -rn "arkd/server.ts" docs/` and `grep -rn "single binary" docs/`. If hits exist
   outside Section 4.1, **do not fix them in this task** (scope creep -- task is a one-line
   note). Note them in the commit body as a follow-up.
5. **Stage and commit**:
   `git add docs/architecture.md PLAN.md` then
   `git commit -m "docs(architecture): note arkd client/server/common split"`.
6. **Verify** with `git log --oneline -1` that the commit landed and `git show --stat HEAD`
   that only the two expected files changed.

## 4. Testing strategy

- No code changed -> no unit tests to write or run.
- `make format` must succeed (Prettier covers Markdown). Run it before committing.
- `make lint` is unaffected by Markdown but is cheap; a quick run is reasonable belt-and-
  braces and matches the pre-commit checklist in CLAUDE.md.
- Manual: `git diff HEAD~1 -- docs/architecture.md` should show one sentence changed in
  Section 4.1 plus the `Last updated:` bump -- nothing else. A reviewer should be able to
  read the diff in under 10 seconds.

## 5. Risk assessment

- **Blast radius:** zero. Documentation only -- no runtime, build, schema, or test surface
  is touched.
- **Misinterpretation of the truncated task:** the missing predicate after "mentioning that"
  could plausibly point elsewhere. Other recent-commit candidates:
  - the test split between unit and compute-e2e (`9e58a6a8`)
  - the autonomous-flow port hardcoding fix (`9e58a6a8`)
  - dropping the flaky attach-sweep test (`96400e59`)
  None of these match `docs/architecture.md` as a target as cleanly as the arkd refactor
  does, since architecture.md Section 4.1 is the only place where text is now factually
  stale because of recent commits. Still, if the implementer or reviewer reads the truncated
  task differently, the edit may need to be redirected -- see Open Questions.
- **Breaking changes / migrations:** none.

## 6. Open questions

- **What does the truncated task title actually say?** The task name ends with `mentioning
  that-` and is cut off. Two answers resolve the ambiguity:
  1. Read the originating issue / message that produced this task name (the planner does not
     have access to it).
  2. Ask the user for the missing predicate.
  If neither is available before implementation, the implementer should proceed with the
  arkd-split interpretation (highest-signal match against recent commits) and call out the
  ambiguity in the commit body so a reviewer can redirect cheaply.
- **If the answer is something other than the arkd split** (e.g. the test-suite split,
  Temporal phasing, or some unrelated subject), this plan does not apply. Abort and re-plan
  rather than shoe-horning the wrong note into Section 4.1.
