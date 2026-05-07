# PLAN: Third e2e attempt -- confirm autonomous-sdlc end-to-end on clean state

## 1. Summary

Third attempt at driving the six-stage `autonomous-sdlc` flow
(plan -> implement -> verify -> review -> pr -> merge) to completion on a
clean branch state. Branch `smoke/clean-fix-e2e` sits at the PR #530 merge
commit (`6cd51e75`) with no commits ahead -- prior attempts on
`smoke/post-pr530-e2e` (planner only) and `smoke/post-pr530-fix-e2e` (PR #531
still OPEN, mergeStateStatus UNSTABLE waiting on `test` + `web-e2e`) did not
reach merge. The "feature" is a deliberately trivial docs-only edit: update
the Conductor row in Section 15 (Ports Reference) of `docs/architecture.md`
from the retired `:19100` port to the post-PR530 merged `:19400` port. The
real point of this task is exercising the flow end-to-end, not the diff.

## 2. Files to modify/create

- `docs/architecture.md` -- update one row of the table at line 1150 (the
  Conductor row in Section 15 "Ports Reference"). Bump `Last updated:` on
  line 4. No other lines touched.
- `PLAN.md` -- this artifact, replaces the stale PLAN.md currently on HEAD
  (which was inherited from PR #518 and describes the older arkd-split task).
  The planner stage commits this; the implementer leaves it alone.

No code, no schema, no migrations, no YAML, no tests, no new files.

## 3. Implementation steps

Each step is independently verifiable. Implementer does NOT touch PLAN.md.

1. **Locate the target row.** Open `docs/architecture.md` and go to
   Section 15 "Ports Reference" (header at line 1146). The Conductor row is
   line 1150 and currently reads:

   ```
   | Conductor | `19100` | No (hardcoded) | References in `conductor.ts`, `channel.ts`, `constants.ts`, tests |
   ```

   This is stale: PR #530 collapsed the standalone `:19100` HTTP server into
   the merged conductor listener on `:19400` (configurable via
   `ARK_CONDUCTOR_PORT` per `CLAUDE.md`'s env-var table).

2. **Replace the row** with the post-PR530 truth. Suggested wording (one
   line, table format preserved):

   ```
   | Conductor | `19400` | Yes (`ARK_CONDUCTOR_PORT`) | Merged listener (PR #530); was `:19100` before the conductor/server merge |
   ```

   Do **not** edit any other rows in the same table -- ArkD, Channel, LLM
   Router, TensorZero, Web UI, Test conductor are all still correct.

3. **Bump `Last updated:`** on line 4 from `2026-04-10` to `2026-05-07`.
   No other header changes.

4. **Run `make format`.** Prettier covers Markdown -- it should be a no-op
   on the table edit. If it reflows the surrounding paragraphs, that is
   acceptable but should be visible in the diff. Investigate any change
   outside the two intended edits before committing.

5. **Run `make lint`.** ESLint does not lint Markdown but the project's
   "Before Committing" checklist (`CLAUDE.md`) requires zero warnings.
   Must exit 0.

6. **Run `make test`.** No test should be affected by a docs-only change.
   If something fails, the failure is a pre-existing flake (likely the same
   `test` / `web-e2e` flakes that left PR #531 in mergeStateStatus
   UNSTABLE). Surface it via the verifier's `report(error)` -- do not paper
   over it. This smoke is exactly the place to catch repeat flakes.

7. **Stage and commit.** Commit message describes the actual change, not
   the smoke meta-task (the meta is the session/PR title):

   ```bash
   git add docs/architecture.md
   git commit -m "docs(architecture): update Conductor port row to :19400 (post-PR530)"
   ```

8. **Verify the commit landed.**
   - `git log --oneline -1` shows the new commit.
   - `git show --stat HEAD` shows exactly one file (`docs/architecture.md`)
     touched, two lines changed (the table row + the date).
   - `git diff main...HEAD -- docs/architecture.md` shows just the two
     edits plus this PLAN.md (which the planner stage put in HEAD~1).

9. **Call `report(completed)`** from the implementer with: files changed
   (`docs/architecture.md`), test result (pass), and a one-line note that
   the diff is intentionally minimal because this is a flow smoke.

## 4. Testing strategy

The autonomous-sdlc verify, review, pr, and merge stages each run their own
checks; the planner does not duplicate that work here.

- **Unit tests:** none added. No source code changes, so no tests are
  needed and none should be added (would be scope creep).
- **`make format`:** must succeed; Prettier-clean.
- **`make lint`:** zero warnings (per CLAUDE.md "Before Committing").
- **`make test`:** must pass. If a flake fails, escalate via `report(error)`
  with the failing test name -- the verify stage exists for this.
- **Manual verification of the diff:**
  `git diff main...HEAD -- docs/architecture.md` should show:
  - one row of the Section 15 table replaced (Conductor row only),
  - the `Last updated:` line bumped from `2026-04-10` to `2026-05-07`,
  - nothing else.
  A reviewer should read the diff in under 10 seconds.
- **Acceptance criterion for the *flow as a whole*:** a PR is created
  against `main`, CI passes, auto-merge merges it, the session reports
  `completed` for all six stages, and `gh pr list --state merged` shows
  the new PR.

## 5. Risk assessment

- **Blast radius:** zero for the docs change itself. One table row in one
  Markdown file -- no runtime, build, schema, or test surface touched.
- **Conflict with the open PR #531** (second-attempt branch, still OPEN
  against `main`, touches Section 5 opener of the same file):
  - Section 5 opener (lines 532-536) and Section 15 table (line 1150) are
    >600 lines apart in the same file. Git should three-way-merge cleanly
    in either order. No anticipated text conflict.
  - If PR #531 lands first via auto-merge before this attempt's PR is
    created, the diff still applies -- the Section 15 row is untouched
    by PR #531.
  - If this attempt's PR lands first, PR #531's diff still applies for
    the same reason.
- **`create_pr` action behaviour on this branch:** `createPullRequest` in
  `packages/core/services/worktree/pr.ts` is idempotent against existing
  PRs (returns the existing URL with `result.existed=true`, line 583).
  Since `smoke/clean-fix-e2e` has no PR yet (`gh pr list --head
  smoke/clean-fix-e2e` returned `[]`), a fresh PR is created.
- **`auto_merge` action behaviour:** runs `gh pr merge --auto` on the
  url returned by `create_pr`. If branch protection requires reviews or
  the same checks (`test`, `web-e2e`) are still pending/flaky, the merge
  sits in `--auto` waiting state. That is still a "flow worked" outcome
  for this smoke; the implementer must NOT force-merge or otherwise
  paper over it.
- **Pre-existing flaky CI** (`test`, `web-e2e` are pending on PR #531):
  if they flake again here, this smoke surfaces it. That is the smoke
  doing its job, not a smoke failure. Verify stage should `report(error)`
  with the failing job name and a link.
- **Branch-name collision on push:** `smoke/clean-fix-e2e` is currently
  unique (no other branches share the name; remote has not seen it yet
  per the empty `gh pr list` result). The auto-rename safety net in
  `pr.ts:508-544` covers the unlikely case where it does collide.
- **Stale PLAN.md on HEAD:** the existing PLAN.md (committed in PR #518)
  describes a completely different task (arkd client/server/common split).
  The planner stage MUST overwrite it with this content; if the
  implementer reads the old PLAN.md first they will be misled.
- **Breaking changes:** none.
- **Migrations:** none.
- **Concurrency / state:** none -- no shared resource is touched.
- **Stale-text drift:** the diff fixes only the table row in Section 15.
  Other `:19100` references remain at lines 75, 180-181, 197, 209, 489,
  680 of `docs/architecture.md`. They are intentionally out of scope --
  a full doc cleanup is a separate, larger task and would balloon the
  diff past the "smoke" threshold. Note them in the commit body as a
  follow-up, do not fix them.

## 6. Open questions

- **Truncated task title** (`third-e2e-attempt-confirm-autonomous-sdlc-
  end-to-end-on-clea`). The trailing `clea` almost certainly truncates
  `clean` (matching the branch name `smoke/clean-fix-e2e` and the
  numbered third-attempt sequence). Best-guess interpretation, used by
  this plan: drive autonomous-sdlc end-to-end on a clean branch
  (no prior smoke commits). If the user intended something else (e.g.
  "on Cleanup PR", "on cleaning up X"), the implementer should pause
  and ask before changing the diff.
- **Whether this attempt should wait for PR #531 to merge first.** This
  plan says no -- the two PRs touch disjoint regions of the same file
  and either ordering merges cleanly. If the user wants serialised
  smokes, they should explicitly cancel/close PR #531 before running
  this attempt.
- **Whether the verify stage should fail closed on pre-existing CI
  flakes.** This plan says yes (escalate, do not paper over). If the
  user wants the smoke to pass *despite* known flakes, the verifier
  needs an allowlist -- that is a flow-engine change, not an implementer
  concern, and should be raised separately.
