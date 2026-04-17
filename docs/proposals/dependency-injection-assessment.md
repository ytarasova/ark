# Dependency Injection Assessment

**Date:** 2025-04-15
**Scope:** Backend (core, server, compute, arkd, router) + Frontend (web)

---

## 1. Current Architecture

Ark uses a hybrid DI approach:

- **Awilix container** (`packages/core/container.ts`) -- defines a typed `Cradle` interface with ~20 keys (config, db, 7 repositories, 3 services, 5 resource stores, knowledge, pricing, usageRecorder, transcriptParsers, pluginRegistry).
- **AppContext** (`packages/core/app.ts`) -- wraps the Awilix container, owns boot/shutdown lifecycle, and exposes typed getters that delegate to `container.resolve(key)`.
- **`getApp()` / `setApp()` globals** -- module-level singleton pattern for code that cannot receive AppContext through parameters.

### How dependencies flow

| Layer | Pattern | Quality |
|---|---|---|
| **session-orchestration.ts** | Every function takes `app: AppContext` as first arg | Good -- explicit, testable |
| **server handlers** | `registerXxxHandlers(router, app)` -- closure over `app` | Good -- explicit, testable |
| **SessionService** | Constructor injection for repos, then `setApp(this)` post-boot | Mixed -- two-phase init |
| **Conductor** | Module-level `let _app: AppContext` set by `startConductor()` | Weak -- hidden module state |
| **Compute** | Module-level `let _app` via `setComputeApp()` | Weak -- hidden module state |
| **provider-registry.ts** | Module-level `let _providerResolver` via `setProviderResolver()` | Weak -- hidden module state |
| **CLI commands** | `getApp()` global singleton | Acceptable for CLI entry points |
| **Tests** | `AppContext.forTest()` + `setApp()` / `clearApp()` | Good isolation |

---

## 2. Evaluation

### 2.1 Is AppContext a proper DI container or just a service locator?

**It is both.** The Awilix container underneath is a real DI container (typed cradle, lifecycle management, `dispose()`). AppContext wraps it as a facade, which makes it a service locator from the caller's perspective -- callers ask `app.sessions` rather than declaring dependencies in their constructor.

However, the key orchestration layer (`session-orchestration.ts`) uses **parameter injection** -- every function receives `app` as first arg. This is functionally equivalent to constructor injection for stateless function modules. The server handler registration also uses explicit parameter passing. These are the two most important subsystems, and they do DI correctly.

**Verdict:** The hybrid is pragmatic and mostly sound. The Awilix container provides typed resolution and lifecycle. AppContext provides a clean facade. The function-parameter pattern in orchestration code is explicit and testable.

### 2.2 Are dependencies explicitly declared or implicitly assumed?

**Mostly explicit, with notable exceptions:**

- **Good:** The `Cradle` interface in `container.ts` explicitly types every resolvable dependency. All orchestration functions declare `app: AppContext` as their first parameter.
- **Gap 1:** The `Cradle` interface is missing `pluginRegistry` -- it is registered in the container via `asValue()` but not declared in the Cradle type. This means `container.resolve("pluginRegistry")` works at runtime but is not type-checked.
- **Gap 2:** `SessionService.setApp()` is a two-phase initialization pattern. The service is constructed with repos, then `app` is injected post-construction. This creates a temporal coupling -- calling any method before `setApp()` throws.
- **Gap 3:** Module-level singletons in `conductor.ts`, `compute/index.ts`, `provider-registry.ts`, and `observability/*.ts` are implicit hidden state. These bypass DI entirely.

### 2.3 Can components be tested in isolation?

**Yes, with `AppContext.forTest()`.** The test factory creates:
- An isolated temp directory
- A fresh SQLite database
- All repositories and services wired through the container
- Conductor, metrics, and signal handlers disabled

There is already a `di-container.test.ts` that verifies all cradle keys resolve, accessors match container resolution, services receive correct constructor injection, and shutdown cleans up.

**The main testing risk** is `getApp()` / `setApp()` global state leaking between test files. Tests must call `clearApp()` in `afterAll`, and parallel test execution is forbidden (documented in CLAUDE.md). This is a real constraint but is well-managed.

### 2.4 Are there hidden dependencies?

**Yes, several module-level singletons:**

| Module | Global | Set by | Used by |
|---|---|---|---|
| `app.ts` | `_app` | `setApp()` / auto in `boot()` | `getApp()` callers (CLI, some tests) |
| `conductor.ts` | `_app` | `startConductor()` | All conductor handler functions |
| `compute/index.ts` | `_app` | `setComputeApp()` | `getProvider()` fallback |
| `provider-registry.ts` | `_providerResolver` | `setProviderResolver()` | `resolveProvider()` |
| `hooks.ts` | `eventBus` | Module-level singleton | Event pub/sub everywhere |
| `observability/*.ts` | `_config`, `_buffer` | `configure*()` | Telemetry, OTLP, structured log |
| `state/profiles.ts` | `_arkDir`, `_activeProfile` | `setProfilesArkDir()` | Profile management |
| `theme.ts` | `_mode`, `_cached` | `setThemeMode()` | Theme rendering |
| `infra/tmux.ts` | `_tmuxBin` | Auto-detected lazily | All tmux operations |

The most problematic are `conductor.ts` and `compute/index.ts` because they store `_app` module-level when it should be threaded through parameters or closures, like the server handlers already do.

### 2.5 Is the DI pattern consistent across packages?

| Package | Pattern | Consistent? |
|---|---|---|
| **core** (orchestration) | `app: AppContext` first param | Yes |
| **core** (services) | Constructor injection + `setApp()` | Partial -- two-phase |
| **server** | `registerHandlers(router, app)` -- closure | Yes |
| **compute** | Module singleton `setComputeApp()` | No -- should use param |
| **arkd** | `startArkd(port, opts)` -- self-contained | Yes (no DI needed) |
| **router** | `startRouter(config, opts)` -- self-contained | Yes (no DI needed) |
| **web** (frontend) | React Context (ThemeProvider, QueryProvider) | Yes -- idiomatic React |

---

## 3. Options Analysis

### Option A: Keep AppContext, formalize it

**Effort:** 1-2 days
**What to do:**
1. Add `pluginRegistry` to the `Cradle` interface (5 min fix)
2. Refactor `conductor.ts` to close over `app` parameter instead of module `_app` (similar to how server handlers work)
3. Refactor `compute/index.ts` to accept `app` as parameter in `getProvider()`
4. Document the DI patterns in CLAUDE.md or architecture docs

**Benefits:**
- Minimal disruption -- no new dependencies, no learning curve
- Fixes the real issues (hidden state, incomplete types) without over-engineering
- Preserves the working `AppContext.forTest()` pattern

**Risks:**
- Low -- these are straightforward refactors
- The `conductor.ts` change requires threading `app` through ~10 handler functions (but server handlers already do this)

### Option B: Lean harder into Awilix

**Effort:** 3-5 days
**What to do:**
1. Move `eventBus`, `launcher`, `workerRegistry`, etc. into the Awilix cradle
2. Use `asClass()` with explicit registration (not name-based) for services
3. Use scoped containers for tenant isolation (instead of `forTenant()` with `Object.create()`)

**Benefits:**
- Cleaner tenant scoping via Awilix scoped containers
- All dependencies visible in one Cradle interface

**Risks:**
- `asClass()` is already documented as broken with `bun build --compile` (minification strips parameter names). The comment in `app.ts` line 497-501 explains this. Using `asValue()` with eager construction is the workaround, which reduces Awilix to a typed registry -- not really DI.
- Awilix scoped containers add complexity without clear benefit over the current `forTenant()` approach
- More Awilix surface area means more coupling to a library that already has friction with Bun

### Option C: Manual constructor injection (no library)

**Effort:** 3-5 days
**What to do:**
1. Remove Awilix entirely
2. AppContext becomes a plain class that constructs everything in `boot()`
3. Dependencies passed via constructors or function parameters

**Benefits:**
- Zero library dependency
- Simpler mental model
- No Bun/minification compatibility issues

**Risks:**
- Loses Awilix's `dispose()` lifecycle management
- Loses typed `Cradle` interface (could be replicated with a plain interface)
- AppContext already does this -- it eagerly constructs everything and registers with `asValue()`. Removing Awilix would mainly remove the Cradle type and container.dispose()

---

## 4. Recommendation: Option A (Formalize AppContext)

The current architecture is fundamentally sound. Awilix is already present and provides value as a typed registry with lifecycle. The real issues are:

1. **Incomplete Cradle type** -- `pluginRegistry` missing from the interface
2. **Module-level singletons** in conductor and compute that bypass DI
3. **Two-phase init** in SessionService (`setApp()` after construction)

These are localized fixes, not architectural problems. Introducing a heavier DI framework or removing Awilix would create churn without proportional benefit.

### Concrete fixes

**Fix 1: Add pluginRegistry to Cradle** -- Add the missing type to `container.ts`.

**Fix 2: Thread app through conductor handlers** -- The conductor already receives `app` in `startConductor(app, port)`. The module `_app` exists because handler functions are defined at module scope. Refactoring to close over the parameter (like server handlers do) eliminates the hidden state.

**Fix 3: Thread app through compute getProvider** -- `getProvider()` in `compute/index.ts` uses module `_app`. Callers should pass `app` explicitly.

**Fix 4: Eliminate SessionService.setApp()** -- Pass AppContext as constructor arg. The circular dependency concern (SessionService needs app, app creates SessionService) can be solved by creating SessionService after the container is populated, or by using a lazy getter.

---

## 5. Frontend Assessment

The web dashboard (`packages/web/`) uses standard React patterns:

- **QueryClientProvider** -- wraps the app with TanStack Query for server state
- **ThemeProvider** -- custom context for theme/color mode

There are no backend dependencies in the frontend -- it communicates via SSE and JSON-RPC. React Context is the idiomatic DI mechanism for React, and the current usage is correct and sufficient. No changes needed.

---

## 6. Summary

| Issue | Severity | Fix |
|---|---|---|
| `pluginRegistry` missing from Cradle | Low | Add type to container.ts |
| `conductor.ts` module-level `_app` | Medium | Close over parameter |
| `compute/index.ts` module-level `_app` | Medium | Pass app to getProvider() |
| `SessionService.setApp()` two-phase | Low | Constructor injection |
| `provider-registry.ts` module singleton | Low | Already isolated by design (breaks circular import) |
| `observability` module singletons | Low | Acceptable -- stateless config, not business logic |
| `getApp()` in CLI commands | None | Correct for CLI entry points |
| Frontend DI | None | React Context is sufficient |

**Overall verdict:** The DI architecture is well-designed. The Awilix container + AppContext facade + parameter injection in orchestration code is a solid pattern. The issues are edge cases (incomplete types, a few module singletons), not fundamental design flaws. Fix the four concrete items above; no framework change needed.
