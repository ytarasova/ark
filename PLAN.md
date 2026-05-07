# PLAN: Second e2e attempt -- confirm autonomous-sdlc flow works post-PR530

## 1. Summary

This is a deliberately trivial smoke task whose real purpose is to drive the
six-stage `autonomous-sdlc` flow (plan -> implement -> verify -> review -> pr ->
merge) to completion after PR #530 merged `packages/server` into
`packages/conductor` and collapsed the legacy `:19100` conductor port into the
merged `:19400` listener. The previous attempt (commit `a4872153` on this
branch) wrote a plan but the flow did not reach merge, so this is the second
attempt. The "feature" is one new sentence in `docs/architecture.md` Section 5
noting the post-PR530 layout. No code, no schema, no tests.

## 2. Files to modify/create

- `docs/architecture.md` -- add one sentence to the opener of Section 5
  ("## 5. Conductor (Control Plane HTTP Server)", currently around lines
  532-536) noting that as of PR #530 the conductor surface is mounted on the
  merged `:19400` listener and the standalone `:19100` HTTP server is gone.
  Bump the `Last updated:` date on line 4 to `2026-05-07`.
- `PLAN.md` -- this artifact, already committed by the planner stage.

No code files, no YAML, no migrations, no tests, no new files.

## 3. Implementation steps

The implementer should keep the diff to a single file change (plus the date
bump). Each step is independently verifiable.

1. **Open `docs/architecture.md` and locate Section 5** (search for
   `## 5. Conductor`). The opener prose currently reads:

   > The HTTP surface of the control plane. Lives in
   > `packages/core/conductor.ts` (with helpers under
   > `packages/core/conductor/`).

   That sentence is stale -- after PR #530 the conductor lives in
   `packages/conductor/` and is mounted on the merged `:19400` listener. **Do
   not rewrite the whole section** -- scope creep. Add exactly one sentence
   immediately after the existing opener:

   > As of PR #530 (May 2026), the conductor and Ark server share a single
   > listener on `:19400`; the standalone `:19100` HTTP server is retired and
   > references to `:19100` elsewhere in this section are historical.

   This addition is intentionally a callout, not a rewrite -- the rest of
   Section 5 still describes the legacy split surface and that cleanup is a
   separate, larger task. Linking the reader to the merged state is enough
   for this smoke.

2. **Bump `Last updated:` on line 4** from `2026-04-10` to `2026-05-07`. No
   other header changes.

3. **Run `make format`.** Prettier covers Markdown -- it should produce no
   diff beyond the two edits above. If it reflows surrounding paragraphs,
   that is acceptable but should be visible in the diff.

4. **Run `make lint`.** ESLint does not lint Markdown but the project's
   pre-commit checklist (CLAUDE.md, "Before Committing") requires it. Must
   exit zero with zero warnings.

5. **Run `make test`.** No test should be affected by a docs-only change, so
   the suite must pass with no new failures vs main. If it fails, the failure
   is pre-existing (PR #530 fallout) and must be reported to the verify
   stage as `report(error)` rather than papered over -- this smoke explicitly
   exercises the failure path of the flow as well as the success path.

6. **Stage and commit** with a message that reflects the actual change, not
   the smoke meta-task:

   ```bash
   git add docs/architecture.md
   git commit -m "docs(architecture): note PR #530 conductor/server merge in Section 5"
   ```

7. **Verify the commit landed**: `git log --oneline -1` shows the new commit;
   `git show --stat HEAD` shows exactly one file (`docs/architecture.md`)
   touched.

8. **Call `report(completed)`** with: files changed (one), test result
   (pass), and a one-line note that the diff is intentionally minimal because
   this is a flow smoke.

## 4. Testing strategy

- **Unit tests:** none added. No source code changes.
- **`make format`:** must succeed; Prettier-clean.
- **`make lint`:** must succeed with zero warnings (per CLAUDE.md "Before
  Committing").
- **`make test`:** must succeed against main's baseline. Any new failure is
  a blocker -- PR #530 may have left a latent test broken; this smoke is the
  natural place to catch that, and it is correct to surface it via the
  verifier rather than to skip the test.
- **Manual verification of the diff:**
  `git diff main...HEAD -- docs/architecture.md` should show:
  - one new sentence inside Section 5 (added, not replaced),
  - the `Last updated:` date line bumped,
  - nothing else.
  A reviewer should be able to read the diff in under 15 seconds.

The verify, review, pr, and merge stages of the autonomous-sdlc flow each
run their own checks; the planner does not duplicate that work here. The
acceptance criterion for the *flow as a whole* is: a PR is created against
main, CI passes, auto-merge merges it, and the session terminates with all
six stages reporting `completed`.

## 5. Risk assessment

- **Blast radius:** zero for the documentation change itself -- one sentence
  in one Markdown file, no runtime, build, schema, or test surface touched.
- **Flow-level risk (the actual point of this smoke):**
  - The `pr` stage uses the `create_pr` action -- if `gh pr create` fails
    (auth, branch already has a PR, base-branch divergence), the flow
    stalls.
  - The `merge` stage uses `auto_merge` (`gh pr merge --squash --auto`) --
    if branch protection requires reviews this will sit in `--auto` waiting
    state. For a smoke, that's still a "flow worked" outcome; the
    implementer should not paper over it by force-merging.
  - The `verify` stage runs the full test suite; any latent post-PR530 test
    flake will surface here. Treat that as the smoke detecting a real
    regression, not as a smoke failure -- escalate via `report(error)` with
    the failing test name.
- **Breaking changes:** none. Pure docs.
- **Migrations:** none.
- **Concurrency / state:** none -- no shared resource is touched.
- **Stale-text drift:** the one sentence acknowledges the merge but does
  *not* fix every `:19100` / `packages/core/conductor.ts` reference in
  Section 5. That is intentional: a full doc cleanup is out of scope for a
  smoke and would balloon the diff. A follow-up task should sweep those.

## 6. Open questions

- **Truncated task title**
  (`second-e2e-attempt-confirm-autonomous-sdlc-flow-works-after-`). The
  trailing hyphen suggests a missing predicate (almost certainly `pr530`,
  given the branch name `smoke/post-pr530-fix-e2e` and the prior attempt's
  plan). If the user intended a different referent, the implementer should
  pause and ask via the conversation surface rather than guess. Best-guess
  interpretation, used by this plan: confirm the autonomous-sdlc flow
  end-to-end after PR #530.
- **Whether the verify stage should fail closed on pre-existing flakes.**
  This plan says yes (escalate, do not paper over). If the user wants the
  smoke to pass *despite* known flakes, the verifier configuration needs an
  allowlist -- that is a flow-engine change, not an implementer concern,
  and should be raised separately.
- **Whether to update other stale `:19100` references in the same diff.**
  This plan says no (scope creep, one-line note is the minimum). If the
  reviewer disagrees, follow-up PR is the right place.
