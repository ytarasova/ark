# Compute Cleanup Design

**Date:** 2026-05-05
**Author:** Yana
**Status:** Draft for review

## Summary

`packages/compute/` carries five overlapping problems: a half-finished two-axis migration with parallel old/new implementations of every provider, a redundant per-repo config file (`arc.json`) that duplicates `ark.yaml`, a phantom isolation kind that has no implementation, an over-engineered flag-spec registry, and a fictional package boundary with cyclic imports. This spec collapses all five into one PR that finishes the migration, deletes the redundancy, and folds `compute/` and `workspace/` back into `core/` where they belong.

## Goals

- Single source of truth for every provider (no more old `providers/Xxx-Provider` parallel to new `core/XxxCompute`)
- Single source of truth for per-repo config (`.ark.yaml` only; no `arc.json`)
- `ComputeTarget` covers the full session lifecycle (launch + post-launch ops), not just launch
- DB schema reflects the two-axis model honestly: only `compute_kind` + `isolation_kind`, no legacy `provider` column
- `packages/` top level shrinks to packages with real boundaries; `compute/` and `workspace/` move under `core/`
- Every smell flagged in the architectural review is gone in one sweep

## Non-goals

- **No backwards compatibility, anywhere.** No deprecation windows, no shims, no dual-read fallbacks, no aliases preserved "for safety". There are no external users. Every removal is final in this PR.
  - `arc.json` parser deleted, format gone.
  - Legacy `provider` column dropped from every table; no fallback read path remains.
  - Old `ComputeProvider` interface and the entire `providers/` directory deleted; no dual-registry boot.
  - `--provider` CLI flag removed outright; replaced by `--kind` + `--isolation`. No alias.
  - Flag-spec registry (interface + Map + per-provider files) deleted; flags live inline in the CLI command.
  - `firecracker-in-container` isolation kind erased from the codebase as a concept. Not registered, not in any union type, not referenced. The new world is `FirecrackerCompute + DirectIsolation`, and that's the only firecracker shape that exists.
- No new provider, no new isolation, no new feature. This is pure cleanup.
- Not redesigning the `Compute` / `Isolation` interfaces beyond adding the post-launch methods that already exist on `ComputeProvider`.

## Current State (the diagnosis)

1. **Two parallel provider hierarchies.**
   - `packages/compute/core/` has the new-world `Compute` implementations: `LocalCompute`, `EC2Compute`, `K8sCompute`, `KataCompute`, `FirecrackerCompute`.
   - `packages/compute/providers/` has the old-world `ComputeProvider` implementations: `LocalWorktreeProvider`, `LocalDockerProvider`, `LocalDevcontainerProvider`, `LocalFirecrackerProvider`, `RemoteWorktreeProvider`, `RemoteDockerProvider`, `RemoteDevcontainerProvider`, `RemoteFirecrackerProvider`, `K8sProvider`, `KataProvider`, plus four `*-placement-ctx.ts` files.
   - `ComputeProvidersBoot` registers both at boot. Launch goes through the new registry (`ComputeTarget` composed from `Compute` + `Isolation`). Post-launch ops (`killAgent`, `captureOutput`, `checkSession`, `getMetrics`) still go through the old registry via `getProvider(providerOf(compute))` in server handlers and CLI.

2. **`arc.json` duplicates `.ark.yaml`.**
   - `packages/core/repo-config.ts` parses `.ark.yaml` (or `.ark.yml`, `ark.yaml`) into a `RepoConfig` with `flow`, `compute`, `group`, `agent`, `env`, `verify`, `auto_pr`, `auto_rebase`, `worktree.copy`, `worktree.setup`. This is the canonical user-facing per-repo config.
   - `packages/compute/arc-json.ts` parses a *separate* user-facing per-repo file (`arc.json`) into an `ArcJson` with `ports`, `sync`, `compose`, `devcontainer`. Born March 21, 2026 — four days before `.ark.yaml` was conceived. Never reconciled.
   - `arc-json.ts:resolvePortDecls` additionally reads `devcontainer.json` and `docker-compose.yml`, doing port-discovery for three different formats inside one module that nominally only owns the `arc.json` format.

3. **Legacy `provider` column still load-bearing.**
   - `compute`, `compute_templates`, and two `hosted_*` tables all carry both the legacy `provider` column and the new `compute_kind` + `isolation_kind` columns.
   - `ComputeRepository.insert` (`packages/core/repositories/compute.ts:123`) still synthesizes the legacy provider string via `pairToProvider({ compute, isolation })` and writes it on every INSERT.
   - ~30 call sites across `packages/server/`, `packages/cli/`, and `packages/core/` import `providerOf`, `providerToPair`, or `pairToProvider` from `packages/compute/adapters/provider-map.ts`.

4. **Phantom isolation kind.**
   - `provider-map.ts` maps `firecracker` -> `{compute: "local", isolation: "firecracker-in-container"}`.
   - `ComputeProvidersBoot` never registers an `Isolation` for `"firecracker-in-container"`. The new-world lookup returns null; the old-world `LocalFirecrackerProvider` catches the fall-through.
   - The new-world equivalent (`FirecrackerCompute` paired with `DirectIsolation`) exists and works. The phantom kind is purely an artifact of the old single-axis world.

5. **Over-engineered flag-spec registry.**
   - `packages/compute/flag-spec.ts` (singular) defines the `ProviderFlagSpec` interface.
   - `packages/compute/flag-specs/` (plural) has six files — `index.ts` plus one per provider — registering ~15 CLI flags into a `Map<string, ProviderFlagSpec>`.
   - The CLI iterates `allFlagSpecs()` to register flags, then dispatches to `getFlagSpec(provider).configFromFlags()` and `.displaySummary()`. Pure ceremony for a fixed, closed set of five providers.

6. **Dead code.**
   - `packages/compute/adapters/legacy.ts:computeProviderToTarget` is exported from `index.ts` and used only by its own test. No production caller.

7. **Fictional package boundary.**
   - `packages/compute/` has no `package.json`. It is a directory pretending to be a package.
   - `compute/arc-json.ts` imports `logDebug` from `core/observability/`. `compute/types.ts` imports `PlacementCtx` from `core/secrets/`. `compute/index.ts` imports `AppContext` from `core/app.ts`. The dependency is already cyclic.
   - `packages/workspace/` was promoted out of `core/` on 2026-05-05 (commit `2e21aebc`) but has the same shape: small implementation detail of core's dispatch, no external consumer beyond core and compute.

## Target Architecture

### Directory layout

```
packages/core/
  ...
  compute/                    # was packages/compute/
    types.ts                  # Compute, Isolation, ComputeHandle, AgentHandle (only contract)
    compute-target.ts
    local.ts                  # LocalCompute (absorbs LocalWorktreeProvider)
    ec2/                      # EC2Compute + provision/ssm/cloud-init/cost/etc
      compute.ts              # EC2Compute (absorbs Remote*Provider post-launch ops)
      provision.ts
      ssm.ts
      cloud-init.ts
      cost.ts
      ports.ts
      ...
    k8s.ts                    # K8sCompute (absorbs K8sProvider)
    k8s-kata.ts               # KataCompute
    firecracker/              # FirecrackerCompute + supporting files (unchanged internals)
    pool/
    snapshot-store.ts
    snapshot-store-fs.ts
    workspace-clone.ts
    isolation/
      direct.ts
      docker.ts               # absorbs container-lifecycle from LocalDockerProvider
      docker-compose.ts       # reads docker-compose.yml directly, no arc.json
      devcontainer.ts         # reads devcontainer.json directly, no arc.json
      types.ts                # was docker-config.ts
    index.ts                  # exports only the new-world surface
  workspace/                  # was packages/workspace/, reverts commit 2e21aebc
    index.ts
    manifest.ts
    provisioner.ts
    store.ts
    types.ts
    __tests__/
```

Top-level `packages/` shrinks by two: `compute/` and `workspace/` are gone.

### Deleted entirely

- `packages/compute/arc-json.ts` and both arc-json test files
- `packages/compute/types.ts` (the old `ComputeProvider` interface)
- `packages/compute/util.ts` (the two helpers fold into `core/compute/ec2/` where they're used)
- `packages/compute/flag-spec.ts` (singular, types) — flags inline in CLI
- `packages/compute/flag-specs/` (plural, registry) — flags inline in CLI
- `packages/compute/adapters/` — both `legacy.ts` and `provider-map.ts`
- `packages/compute/providers/` — entire directory: `arkd-backed.ts`, `local-arkd.ts`, `remote-arkd.ts`, `k8s.ts`, all four `*-placement-ctx.ts`. Helper subdirectories (`providers/ec2/*`, `providers/docker/*`) are reabsorbed: ec2 helpers become `core/compute/ec2/` siblings; docker helpers move into `core/compute/isolation/` next to their consumers.
- `packages/workspace/package.json` and `packages/workspace/tsconfig.json`

### Post-launch ops on the new interfaces

The four operations that today live only on `ComputeProvider` move onto the new interfaces:

| Operation | New home | Rationale |
|---|---|---|
| `killAgent(handle)` | `AgentHandle.kill()` | `Isolation.launchAgent` returns the `AgentHandle`; it owns the agent lifecycle |
| `captureOutput(handle)` | `AgentHandle.captureOutput()` | Same — agent-scoped |
| `checkSession(handle)` | `AgentHandle.checkAlive()` | Same — agent-scoped |
| `getMetrics(handle)` | `ComputeHandle.getMetrics()` | Compute owns the box; metrics are box-scoped |

All four delegate to arkd via the URL captured at launch (`compute.getArkdUrl(handle)`).

After this lands, `ComputeTarget` covers the full lifecycle — `provision`, `ensureReachable`, `prepareWorkspace`, `prepare`, `launchAgent`, `kill`, `captureOutput`, `checkAlive`, `getMetrics`, `destroy`. There is no remaining reason for the old registry to exist.

### Schema change

One new migration: `010_drop_legacy_provider_columns.ts`.

- Drops `provider` from `compute`, `compute_templates`, `hosted_compute_templates` (or whichever `hosted_*` tables carry it — see `drizzle/schema/sqlite.ts:124, 371-2, 450, 502` and the matching postgres locations).
- Drops `idx_compute_provider`.
- Data fixup for the phantom `firecracker-in-container` kind: any row with `compute_kind = 'local' AND isolation_kind = 'firecracker-in-container'` is coerced to `compute_kind = 'firecracker' AND isolation_kind = 'direct'` (the new-world `FirecrackerCompute + DirectIsolation` pairing). Same fixup applied to `compute_templates`.
- Generated for both dialects via `drizzle-kit generate` per CLAUDE.md migrations workflow.

### CLI surface change

`ark compute create` loses `--provider` and gains `--kind` + `--isolation`. The ~15 per-provider option flags (`--image`, `--aws-region`, `--k8s-namespace`, etc.) move inline into `packages/cli/commands/compute/create.ts`. The `configFromFlags` and `displaySummary` per-provider helpers become a `switch (kind)` block in the same file. Total inline footprint ~80-120 lines, one file, no abstraction.

### `arc.json` field migration (none)

Each former `arc.json` field is handled by what already exists, or stops being configurable:

| Old field | New source |
|---|---|
| `sync` | `.ark.yaml` `worktree.copy` (already exists, identical semantics) |
| `compose` | Auto-detected: presence of `docker-compose.yml` in the workspace root + `isolation_kind = "docker-compose"` |
| `devcontainer` | Auto-detected: presence of `.devcontainer/devcontainer.json` + `isolation_kind = "devcontainer"` |
| `ports` | Auto-discovered from `devcontainer.json` `forwardPorts` and `docker-compose.yml` `ports` by the relevant `Isolation` implementation |

No data moves into `.ark.yaml`. The format stays exactly as `RepoConfig` defines it today.

## Migration Order (within the single PR)

The PR is one commit landing all of the below, but the work is staged internally so each intermediate commit (if reviewers want them split for inspection) leaves the build green.

1. **Move `packages/compute/` to `packages/core/compute/` and `packages/workspace/` to `packages/core/workspace/`.** Pure `git mv` plus relative-import fixups: external consumers (`cli/`, `server/`, `web/`, `types/`, `arkd/`) update their `from "../compute/..."` to `from "../core/compute/..."`; internal `core/` imports of compute that previously went through cyclic `from "../compute/..."` collapse to local relative paths. Delete `workspace/package.json` and `workspace/tsconfig.json`. Build green.

2. **Delete `arc-json.ts` + `ArcJson` types + tests.** Update `DockerComposeIsolation` to read `docker-compose.yml` directly. Update `DevcontainerIsolation` to read `devcontainer.json` directly (using existing `strip-json-comments` JSONC handling). Update executor port-discovery in `core/executors/claude-code.ts` and `core/executors/goose.ts` to call new helpers in `isolation/` instead of `arc-json`. Build green.

3. **Move post-launch ops onto `AgentHandle` and `ComputeHandle`.** Implement on every new-world class. Update server handlers (`packages/server/handlers/resource-compute.ts` etc.) to call through `ComputeTarget` instead of `getProvider(providerOf(compute))`. Build green.

4. **Delete `providers/` directory.** Drop the legacy registry from `ComputeProvidersBoot`. Delete `core/compute/providers/`, `core/compute/types.ts` (old `ComputeProvider`), `adapters/legacy.ts`. Build green.

5. **Fully remove the legacy `provider` column and its translation layer.** Migration `010_drop_legacy_provider_columns.ts` drops the column from every table that carries it (`compute`, `compute_templates`, the `hosted_*` tables) and drops `idx_compute_provider`. Schema edits in both `drizzle/schema/sqlite.ts` and `postgres.ts`. The same migration runs the firecracker data fixup. Sweep every caller of `providerOf` / `pairToProvider` / `providerToPair` (~30 import sites across cli/server/core) and replace with direct use of `compute_kind` + `isolation_kind`. Delete `adapters/provider-map.ts` and the now-empty `adapters/` directory. Remove the `--provider` flag from `ark compute create` and replace with `--kind` + `--isolation`. After this step, grep for `provider:` in INSERT statements, `providerOf`, `providerToPair`, `pairToProvider`, and `compute.provider` returns zero hits in production code. Build green.

6. **Delete the flag-spec abstraction; inline what survives.** Delete `flag-specs/` directory (six files) and root `flag-spec.ts`. The ~15 surviving CLI options (`--image`, `--aws-region`, `--k8s-namespace`, etc.) are declared directly on the `cmd.option(...)` chain in `packages/cli/commands/compute/create.ts`. The five `configFromFlags` helpers collapse into one `switch (kind)` block in the same file. The five `displaySummary` helpers collapse the same way. No `Map`, no `ProviderFlagSpec` interface, no `allFlagSpecs()` / `getFlagSpec()` lookups. Build green.

7. **Erase phantom `firecracker-in-container` kind from the code.** Remove the value from `IsolationKind` union, from `provider-map.ts` mappings (which are being deleted anyway in step 5), and from any switch/lookup that names it. The data fixup in step 5's migration handles existing rows. After this step, grep for `firecracker-in-container` returns zero hits anywhere in the repo. Build green.

8. **Final pass.** Scrub `packages/core/compute/index.ts` to export only the new-world surface. Delete root `util.ts` (move helpers into `ec2/`). Scrub doc comments referencing dead modules. Run `make format && make lint && make test`.

## Risk Assessment

- **Blast radius is large.** Schema migration on four tables, ~30 import-site sweep, deletion of ~30 files, two directory moves. Mitigated by step-by-step internal sequencing where each step type-checks. CI runs the full test matrix on the result.
- **Drizzle schema migration on both dialects.** Standard process per CLAUDE.md ("Schema + migrations" gotcha). `make drift` gates the PR.
- **Dispatch path is the heart of the product.** All `make test` runs must pass; the dispatch e2e tests (`packages/core/__tests__/e2e-dispatch-compute.test.ts`, `packages/compute/__tests__/e2e.test.ts`) are the safety net for the post-launch-op migration. If they go red and we can't tell why, slow down rather than disable.
- **Test files for deleted modules.** `packages/compute/__tests__/legacy-adapter.test.ts`, `arc-json.test.ts`, `arc-json-compose.test.ts`, `provider-map.test.ts` all delete with their target. New post-launch-op behaviour gets tests added on the new-world classes.

## Out of Scope (deferred to follow-ups)

- Renaming `core/compute/` substructure further (e.g. `core/` -> `compute/` inside the new home — the existing layout works).
- Pool refactors. The pool abstraction stays put.
- Snapshot store improvements.
- Any change to `arkd` itself.
- Any change to runtime YAML definitions in `runtimes/`.
- Anything in `core/services/dispatch/` beyond the call-site changes that the post-launch-op migration forces.
