# Dependency Injection in Ark

Ark uses [awilix](https://github.com/jeffijoe/awilix) as its DI container. This doc explains the pattern so you can add services, resolve dependencies, and override bindings in tests without fighting the wiring.

## Why awilix

We evaluated a few options before picking awilix:

| Library                  | Why not                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsyringe` / `inversify` | Decorator-based. Requires `experimentalDecorators` + `reflect-metadata`. Our `tsconfig` runs with `strict: false` and no decorator metadata, so there's nothing to gain and real cost to adding them. |
| Plain factory functions  | No scope management, no lifecycle hooks, every caller rebuilds the graph.                                                                                                                             |
| **awilix**               | Functional API, no decorators, Bun-compatible, first-class lifecycle + scoped containers. Bundles cleanly under `bun build --compile`.                                                                |

## The container

The composition root lives in `packages/core/di/`:

```
packages/core/di/
  persistence.ts   -- database, repositories, resource stores, knowledge
  services.ts      -- SessionService, ComputeService, HistoryService
  runtime.ts       -- pricing registry, usage recorder, transcript parsers,
                      plugin registry, snapshot store
  index.ts         -- composition root: buildContainer({ app, config, db })
```

The `Cradle` type in `packages/core/container.ts` is the authoritative list of everything resolvable from the container.

## Injection mode: PROXY

We use `InjectionMode.PROXY`. Factories registered via `asFunction` receive the cradle proxy as a single argument and access dependencies via property lookup:

```ts
container.register({
  sessionService: asFunction(
    (c: { sessions: SessionRepository; events: EventRepository; messages: MessageRepository; app: AppContext }) =>
      new SessionService(c.sessions, c.events, c.messages, c.app),
    { lifetime: Lifetime.SINGLETON },
  ),
});
```

Property access is string-based, so the pattern survives `bun build --compile` minification. We avoid `asClass(...).classic()` because it introspects constructor parameter names -- those get mangled by the compiler, breaking resolution in the packaged binary.

## Scopes

- **Singleton** (`Lifetime.SINGLETON`). One instance per container. Used for repositories, stores, config, pricing registry, transcript parser registry, snapshot store, every service.
- **Scoped** (`Lifetime.SCOPED`). One instance per scoped sub-container. Reserved for per-RPC tenant contexts (see `AppContext.forTenant(tenantId)`).
- **Transient** (`Lifetime.TRANSIENT`). Fresh instance every resolve. Used for factories that mint new handles on demand (none today -- the primary future use is per-session orchestration context).

## Resolving dependencies

Inside the app, prefer the typed `AppContext` accessors:

```ts
const service = app.sessionService;
const db = app.db;
```

These are thin getters that delegate to `app.container.resolve(key)`, so accessors and direct container reads return the same singleton.

For new code that doesn't already carry an `AppContext`, resolve from the container directly:

```ts
import { getApp } from "packages/core/app.js";
const svc = getApp().container.resolve("sessionService");
```

## Adding a new service

1. Decide the concern. Repositories/stores go in `di/persistence.ts`; services go in `di/services.ts`; registries/pools go in `di/runtime.ts`.
2. Add the type to the `Cradle` interface in `packages/core/container.ts`:

   ```ts
   export interface Cradle {
     // ...
     myService: MyService;
   }
   ```

3. Register the factory in the appropriate `di/*.ts` file:

   ```ts
   container.register({
     myService: asFunction((c: { db: DatabaseAdapter; sessions: SessionRepository }) => new MyService(c.db, c.sessions), {
       lifetime: Lifetime.SINGLETON,
     }),
   });
   ```

4. (Optional) Add an accessor to `AppContext`:

   ```ts
   get myService(): MyService {
     return this._resolve("myService");
   }
   ```

5. If the service owns resources that need tearing down on shutdown, add a `dispose` hook:

   ```ts
   myService: asFunction((c) => new MyService(c.db), {
     lifetime: Lifetime.SINGLETON,
     dispose: (instance) => instance.close(),
   }),
   ```

   Awilix calls `dispose` for every registered factory during `container.dispose()`.

## Lifecycle

`AppContext.boot()` builds the container via `buildContainer()` once the DB is open:

```
constructor -> register config + app (placeholder container)
boot()
  open db (async)
  init schema + seed
  buildContainer({ app, config, db }) -- replaces the placeholder
  register providers, launcher, workers, etc.
shutdown()
  drain pending dispatches
  stop running sessions
  tear down infrastructure (conductor, arkd, pollers, router, telemetry)
  container.dispose() -- fires `dispose` hooks, closes DB
```

The DB registration has a `dispose` hook that calls `db.close()`, so `container.dispose()` cleans up the connection for every container (including per-test containers).

## Overriding dependencies in tests

The container is mutable after boot: `container.register(...)` replaces a prior registration. This is how test doubles swap in.

```ts
import { asValue } from "awilix";
import { AppContext, setApp, clearApp } from "packages/core/app.js";

let app: AppContext;
beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});
afterEach(async () => {
  await app.shutdown();
  clearApp();
});

it("swaps the sessions repo with a fake", () => {
  const fakeRepo = {
    get: mock(() => ({ id: "fake", status: "running" })),
    update: mock(() => {}),
    list: mock(() => []),
    create: mock(() => ({ id: "fake", status: "pending" })),
  };
  app.container.register({ sessions: asValue(fakeRepo) });

  // Any code that resolves `sessions` (or a service that depends on it)
  // after this point sees the fake. Services captured before the override
  // keep the original -- awilix singletons cache by reference.
});
```

Three patterns in the test suite demonstrate this:

- `packages/core/services/__tests__/session.test.ts` -- swap `events` with a spy, swap `sessions` with a fake.
- `packages/core/services/__tests__/compute.test.ts` -- swap the whole compute repo, verify real repo is untouched.
- `packages/core/services/__tests__/history.test.ts` -- swap the DB with a separate in-memory instance.

## Caveats + gotchas

- **Singletons are cached by reference.** Once `app.sessionService` has been resolved, that specific instance is returned forever -- even if you re-register `sessions` with a fake. To get a service wired to the new fake, construct and register a fresh instance:

  ```ts
  app.container.register({
    sessions: asValue(fakeRepo),
    sessionService: asValue(new SessionService(fakeRepo, app.events, app.messages, app)),
  });
  const fresh = app.container.resolve("sessionService"); // uses fakeRepo
  ```

- **`AppContext.forTestAsync()` always builds a real container.** It's parallel-safe (fresh arkDir + ports per call), so you don't need to mock the container itself -- you mock specific registrations.

- **`AppContext.forTest()` is the legacy sync factory.** Still supported for old tests; new tests should use `forTestAsync()`.

- **Remaining migrations.** Pools, router, conductor-adjacent bits (worker registry, scheduler, tenant policy manager, compute providers) still live as direct fields on `AppContext`. They're slated for future PRs -- follow the pattern above when migrating.
