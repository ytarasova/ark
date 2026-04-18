# ADR-004: DI Container and Hexagonal Architecture Migration

## Status
Proposed

## Context

`packages/core/app.ts` (AppContext) is a 1083-line service-locator class that wires
all infrastructure and passes itself as the first argument to every function in
`packages/core/services/*`. Current problems:

- Domain logic in `session-lifecycle.ts`, `stage-orchestrator.ts`, and
  `agent-launcher.ts` calls `child_process`, `fs`, and tmux directly -- no
  abstraction layer.
- `app.ts:17` already imports `awilix`; `container.ts` declares a Cradle with
  all repository and service types. Awilix is already chosen but used only as a
  typed value map (all registered via `asValue()`). No scoped lifetimes, no
  factory registrations.
- Two deployment modes exist today (`!!config.databaseUrl` branch in
  `app.ts:929-991`) but are decided with an inline boolean instead of a
  composition root that swaps adapter sets.
- `AppContext.forTenant()` (app.ts:302) creates scoped repos with `Object.defineProperty`
  overrides -- brittle and bypasses the container.
- `AppContext.forTest()` (app.ts:1048) creates a real filesystem temp dir; tests
  boot the full infrastructure. No in-memory adapter swap is possible today.
- The `SessionLauncher` port (`session-launcher.ts`) is a good precedent: an
  interface owned by the domain, with `TmuxLauncher` as the local adapter. This
  pattern needs to be applied uniformly.

## Decision

**Keep Awilix. Extend it properly with scoped containers and typed binding modules.**

Awilix is already a dependency (`container.ts:11`), is Bun-compatible, decorator-free,
supports `CLASSIC` injection mode (safe under `bun build --compile` as noted in
`app.ts:498-500`), and supports child containers via `createScope()`. No new
runtime dependency is needed.

Migrate to hexagonal by:

1. Defining every infrastructure touch point as a TypeScript interface (port) in
   `packages/core/ports/`.
2. Implementing each port as an adapter in `packages/core/adapters/{local,control-plane,test}/`.
3. Introducing three binding modules (`LocalBindings`, `ControlPlaneBindings`,
   `TestBindings`) that register the correct adapter for each port.
4. Replacing the `!!config.databaseUrl` branch in `_registerContainer` with a
   call to the appropriate binding module.
5. Replacing `AppContext.forTest()` with a `TestBindings` module that registers
   in-memory adapters; no real filesystem or SQLite needed.

## Rationale for Awilix over alternatives

- **tsyringe**: requires `reflect-metadata` and decorators. `strict: false` tsconfig
  makes decorator-based DI fragile; `bun build --compile` strips them.
- **inversify**: same decorator requirement; heavier runtime.
- **Homegrown container**: Awilix already present and working. Re-implementing
  child containers, disposal, and CLASSIC injection is not worth the maintenance
  cost when Awilix already solves it.
- **Awilix**: decorator-free, `createScope()` for child containers, `asFunction`/
  `asClass`/`asValue` for lifetime control, MIT license.

## Consequences

**Positive:**
- Domain code (`session-lifecycle.ts`, `stage-orchestrator.ts`) stops importing
  `child_process`, `fs`, and tmux directly. All I/O goes through injected ports.
- `AppContext.forTest()` becomes a thin wrapper over `TestBindings.build()`.
  Tests get in-memory SQLite (already `bun:sqlite` in-memory mode), in-memory
  event bus, no-op process runner.
- Control-plane mode is isolated to `ControlPlaneBindings`: stubs can throw
  `NotImplementedError` with clear messages rather than silently diverging.
- `forTenant()` becomes a scoped container created from the root container.

**Negative / risks:**
- Migration is high-effort: ~6 services, ~12 ports, 3 adapter sets.
- Awilix `CLASSIC` injection requires constructor parameter names to match
  cradle keys -- already the case but must stay true as parameters are added.
- Existing tests that rely on `AppContext.forTest()` continue to work during
  migration (shim stays) but will gradually move to `TestBindings`.

## Alternatives Considered

- **Full replacement with homegrown container**: rejected -- Awilix is already
  present and working.
- **Inversify with decorators**: rejected -- incompatible with `bun build --compile`
  name-mangling (documented at `app.ts:498-500`).
- **Keep AppContext as-is, only add port interfaces**: rejected -- interfaces
  without enforced boundaries provide no test-time safety.

## Open Questions

- Does Awilix `createScope()` need any adjustment for Bun's module system?
  (Needs a spike -- low risk, Awilix is pure JS.)
- Should `forTenant()` use a child Awilix scope or stay as prototype override?
  Child scope is cleaner but requires re-registering all tenant-overridable repos.
- Where does `globalThis` usage in `hooks.ts` eventBus fit? It is a process-wide
  singleton. The port should accept injection; the global export stays for
  backward compat during migration.
