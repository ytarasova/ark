# Agent 2 - Test Quality & E2E Mandate Audit

## Summary

The `packages/e2e/web/` suite covers most pages (18 spec files, ~104 happy-path tests). Session-detail tab switching is well covered (`session-detail-tabs.spec.ts`). However, multiple user-visible surfaces have no edge/error coverage, several `test.skip()` calls have no tracking issue, and a whole category of "tests" under `packages/web/src/__tests__/*` are source-code greps masquerading as behavior tests (the pattern called out in the scope). The worst offender is `attachments.test.ts`: it reads `session-lifecycle.ts`, `task-builder.ts`, `workspace-service.ts` as strings and asserts `toContain("...")` - it would pass on a semantically broken refactor. On the core side, the six new decomposed services (session-lifecycle, stage-orchestrator, agent-launcher, workspace-service, task-builder, session-hooks, session-output) have **zero direct unit tests** - they are only reached through heavy integration tests that require real tmux + real filesystem, making them control-plane-incompatible.

## Severity Distribution
Critical: 3 - High: 6 - Medium: 7 - Low: 3

## E2e Coverage Matrix

| Web Surface | Happy Path Spec | Edge/Error Spec | Gap? |
|---|---|---|---|
| SessionsPage list | sessions.spec.ts:18 | sessions.spec.ts search ok; filter chips **skipped** | Partial |
| Session detail tabs (Conversation/Terminal/Events/Diff) | session-detail-tabs.spec.ts:42-137 | - | Missing error state (empty events, no diff) |
| Session detail: Todos tab | session-detail.spec.ts:83 (read) | **skipped** (:91) | Yes |
| Session detail: Attachments tab | - | - | **Yes - no e2e** |
| Session detail: Artifacts tab | - | - | **Yes - no e2e** |
| NewSessionModal | session-creation.spec.ts (5 tests) | - | Missing validation error paths |
| FolderPickerModal | - | - | **Yes - no e2e** |
| ComputePage / drawer | compute-page.spec.ts, compute.spec.ts | - | Missing compute-unreachable error path |
| CostsPage | costs.spec.ts (4 tests) | - | Missing empty-state/error |
| FlowsPage + editor | flows.spec.ts, flows-page.spec.ts | - | Missing invalid-flow save error |
| SchedulesPage | schedules.spec.ts (3 tests) | - | Missing invalid cron error |
| MemoryPage | memory.spec.ts (2 tests) | - | Minimal |
| HistoryPage | history.spec.ts (3 tests) | - | OK |
| ToolsPage | tools.spec.ts (3 tests) | - | Minimal |
| AgentsPage | agents-flows.spec.ts (7 tests) | - | Missing YAML-invalid path |
| SettingsPage | - | - | **Yes - no e2e at all** |
| LoginPage | - | - | **Yes - no e2e at all** |
| DesignPreviewPage | - | - | No e2e (acceptable, dev-only) |
| DashboardPage | dashboard.spec.ts (1 test) | nav-click **skipped** | Thin |
| Theme switching | theme-switching.spec.ts (8 tests) | - | OK |
| Navigation | navigation.spec.ts (19 tests) | - | OK |

## Desktop Smoke Coverage Matrix

| Desktop Concern | Spec | Gap? |
|---|---|---|
| App launch + React mount | launch.spec.ts:31 | OK |
| Window visible within 20s | launch.spec.ts:58 | OK |
| Branding (app name, menu label, dock) | branding.spec.ts (3 tests) | OK (macOS-only skips are justified) |
| Window chrome / traffic-light avoidance | window-chrome.spec.ts | OK |
| CLI install menu item | cli-install.spec.ts:26 | OK |
| Daemon-status dot on sidebar | daemon-status.spec.ts (2 tests) | OK |
| preload.js `arkDesktop` bridge values | - | **Yes - contextBridge surface untested** |
| DOMContentLoaded body class tagging (`is-electron`, `is-macos`) | - | **Yes - no test asserts these classes are set post-load** |

## Skipped Tests Without Tracking

| File:Line | Test Name | Reason Given | Issue Link? |
|---|---|---|---|
| packages/e2e/web/session-detail.spec.ts:91 | "add todo via detail panel UI" | "UI removed, re-enable if it returns" | **No issue** |
| packages/e2e/web/dashboard.spec.ts:71 | "clicking a Dashboard widget navigates..." | "Dashboard removed from top-level nav" | **No issue** |
| packages/e2e/web/sessions.spec.ts:45 | "sessions page shows filter chips" | UI hidden behind icon toggle | **No issue** |
| packages/e2e/web/sessions.spec.ts:122 | "filter chips show only matching status" | FilterChip rewrite, no "All" chip | **No issue** |
| packages/web/e2e/session-view.spec.ts:123 | stage progress bar failed segment | "no failed sessions in data" (runtime gate, not tracked skip) | **No issue, data-dependent skip is flaky** |
| packages/web/e2e/session-view.spec.ts:143 | "failed session detail" | same | same |
| packages/desktop/tests/branding.spec.ts:37,52 | macOS menu / dock | platform gate - acceptable | N/A (legitimate) |
| packages/desktop/tests/window-chrome.spec.ts:33 | traffic-light chrome | platform gate - acceptable | N/A (legitimate) |

## Findings

| ID | Severity | File:Line | Category | Title | Evidence | Proposed Fix | Effort | Depends On |
|---|---|---|---|---|---|---|---|---|
| T1 | Critical | packages/web/src/__tests__/attachments.test.ts:93-118 | tests-implementation | Test asserts string contents of 3 service files instead of behavior | `readFile(...)` + `toContain("attachments: opts.attachments.map")`, `toContain('.ark", "attachments"')` - would pass on a broken refactor as long as substrings remain | Replace with a real integration test against `SessionService.createSession` that verifies files land in `.ark/attachments/` and prompt includes "## Attached Files" | M | - |
| T2 | Critical | packages/web/src/__tests__/{color-theme,terminal-display,event-timeline,detail-drawer,maximize-button,session-layout,session-view-e2e,stage-progress-bar,filter-chips,rich-select,theme-provider,conversation-timeline}.test.ts | tests-implementation | **12 source-grep "tests"** under `packages/web/src/__tests__/` that readFileSync the .tsx and assert `toContain(...)` - whole-category smell named in the audit scope | All 12 files follow the `readFile("components/*.tsx") + toContain` pattern | Delete them; coverage belongs in `packages/e2e/web/` (real RPC+DOM) or in React Testing Library component tests that render the component | L | Deps: real component-test harness |
| T3 | Critical | packages/core/services/{session-lifecycle,stage-orchestrator,agent-launcher,workspace-service,task-builder,session-hooks,session-output}.ts | untested-critical-path | None of the 7 newly decomposed services has a direct test file. Grep `packages/core/__tests__` returns zero matches | 7 files, ~aa42428 refactor. Only reached via tmux+fs integration tests (`e2e-session-lifecycle.test.ts`, `e2e-dispatch-compute.test.ts`) | Add focused unit tests per service with AppContext.forTest + stubbed fs/tmux ports (introduces the port boundary the hex audit wants) | L | Filesystem + tmux port abstraction (Agent 1) |
| T4 | High | packages/e2e/web/* | missing-e2e | SettingsPage and LoginPage have zero e2e coverage | `grep -l settings\|login` returns only theme-switching.spec.ts | Add `settings.spec.ts` + `login.spec.ts` (RPC-roundtrip + DOM) | M | - |
| T5 | High | packages/e2e/web/session-detail*.spec.ts | missing-e2e | Attachments tab and Artifacts tab (both user-visible features) have no tab-switch e2e | session-detail-tabs.spec.ts tests only Conversation/Terminal/Events/Diff | Extend session-detail-tabs.spec.ts with attachments + artifacts tab assertions | S | - |
| T6 | High | packages/web/e2e/session-view.spec.ts:123,143 | brittle-test | Two tests conditionally `test.skip(true, ...)` when fixture data lacks failed sessions - non-deterministic coverage | `if (count === 0) test.skip(true, ...)` | Seed fixture with a failed session (session/start + forced failure state) so the path always runs | M | - |
| T7 | High | packages/web/e2e/session-view.spec.ts:1-10 | local-only-test | This suite requires `make dev` running on :5173 (hard-coded); does not use `setupWebServer` fixture like `packages/e2e/web/*` | Header: "Prerequisites: dev server running on localhost:5173" | Migrate to `setupWebServer()` fixture in `packages/e2e/web/` and delete the `packages/web/e2e/` dir to remove the split | M | - |
| T8 | High | packages/core/__tests__/tmux.test.ts, tmux-notify.test.ts, checkpoint.test.ts, e2e-*.test.ts (20 files match `tmux\|spawn\|new-session`) | local-only-test | 20 tests require real tmux binary on PATH - cannot run in control-plane CI without shell abstraction | `test-helpers.ts` shells to `tmux new-session`, same for arkd boot | Introduce a TmuxPort; keep current tests behind a `@local-only` tag | L | Tmux port abstraction (Agent 1) |
| T9 | High | packages/core/__tests__/{autonomy,delete-session,claude-hooks,worktree-setup,e2e-autonomy,e2e-dispatch-compute}.test.ts | local-only-test | Tests assert fs state with real `readFileSync(join(app.config.arkDir, ".claude", "settings.local.json"))` - requires real disk writes | ~40 raw `readFileSync` calls to arkDir/claudeDir inspect real fs | Move to in-memory FileSystemPort; port-contract tests cover real fs separately | L | FileSystemPort (Agent 1) |
| T10 | High | packages/e2e/web/session-detail.spec.ts:91, dashboard.spec.ts:71, sessions.spec.ts:45, sessions.spec.ts:122 | untracked-skip | 4 `test.skip()` calls with no linked issue - reason given is a comment, not tracking | Comments reference removed UI but no issue number | Either re-enable, delete, or add `// issue: #NNN` linking a follow-up | S | - |
| T11 | Medium | packages/desktop/tests/ | missing-smoke | No test asserts `window.arkDesktop.platform` or body classes `is-electron`/`is-macos` are applied after DOMContentLoaded (preload.js:17-22 is live code) | preload.js contract untested | Add preload.spec.ts that `page.evaluate(() => window.arkDesktop)` and asserts classes on document.body | S | - |
| T12 | Medium | packages/web/src/__tests__/session-view-e2e.test.ts | brittle-test | Name contains "e2e" but it is a source-grep test (readFile + toContain) - misleading file name and contract | :71-142 readFile of Layout.tsx, SessionsPage.tsx, SessionDetail.tsx, SessionList.tsx, timeline-builder.ts | Rename or delete; real e2e lives in packages/e2e/web | S | T2 |
| T13 | Medium | packages/e2e/web/costs.spec.ts, memory.spec.ts, tools.spec.ts, schedules.spec.ts | missing-e2e | Only happy-path tests exist. No coverage for empty-state, RPC error, permission-denied | 2-4 tests per page | Add one "error path" test per page (force RPC to reject) | M | - |
| T14 | Medium | packages/core/__tests__/stage-isolation.test.ts, stage-handoff.test.ts, stage-validation-e2e.test.ts | untested-critical-path | `stage-orchestrator.ts` behavior is asserted through 3 adjacent tests that each spin real tmux | No direct unit tests on the orchestrator's state transitions | Add stage-orchestrator.test.ts exercising advance/fail/skip paths against test AppContext | M | T3 |
| T15 | Medium | packages/e2e/web/dispatch.spec.ts | missing-e2e | Only 5 happy paths; fan-out edge (partial dispatch failure) and compute-unreachable paths absent | Grep count | Add one fan-out-with-failure test | M | - |
| T16 | Medium | packages/core/__tests__/session-share.test.ts:60 | mock-only | JSON.parse(readFileSync(...)) inspects a file written by the code under test - bypasses the SessionStore API entirely | `require("fs").readFileSync(filePath, "utf-8")` | Assert through `app.sessions.get(...)` instead of reading raw JSON | S | - |
| T17 | Medium | packages/core/__tests__/agent.test.ts:241, stores/agent-store.test.ts:151 | tests-implementation | Uses `require("fs").readFileSync(...yaml)` to verify agent persistence rather than calling the store API | :241, :151 | Read back via `app.agents.get(slug)` | S | - |
| T18 | Low | packages/e2e/web/theme-switching.spec.ts | brittle-test | 8 tests on a single toggle; risk of redundant coverage | Count from grep | Consolidate into 1-2 round-trip tests | S | - |
| T19 | Low | packages/desktop/tests/daemon-status.spec.ts | missing-smoke | Asserts dot renders but not IPC wiring to real daemon-status RPC | :33, :46 (2 tests) | Add assertion that status transitions on daemon toggle | S | - |

## Top 5 Test Bets

1. **Delete the 12 source-grep "tests" in `packages/web/src/__tests__/`** (T1, T2, T12) and replace `attachments.test.ts` with a real integration test. Current suite gives false confidence - a refactor that renames a variable but keeps behavior will fail; a refactor that breaks behavior but keeps the string will pass.
2. **Add direct unit tests for the 7 decomposed services** in `packages/core/services/` (T3). They are the hex-architecture target, currently only reached through 300+ line tmux+fs integration tests.
3. **Migrate `packages/web/e2e/session-view.spec.ts` into `packages/e2e/web/` with the `setupWebServer` fixture** (T7) and remove the data-dependent `test.skip(true, ...)` gates (T6). One suite, deterministic fixtures.
4. **Settings + Login e2e specs** (T4). Both pages are user-visible and authentication-critical; both have zero coverage.
5. **Gate tmux/fs-coupled tests behind `@local-only`** (T8, T9) once FileSystemPort + TmuxPort land, so CI can split `make test` (pure) from `make test-local` (integration). Without this, control-plane mode cannot run the core test suite.
