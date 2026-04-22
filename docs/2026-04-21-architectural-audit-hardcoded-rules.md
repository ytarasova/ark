# Architectural Audit: Hardcoded Rules (2026-04-21)

Summary: **3 P0 findings, 5 P1 findings, 1 P2 finding.** Recurring anti-pattern: capability flags declared on `ComputeProvider` (`packages/compute/types.ts`) are shipped by every provider but never read by the repository, RPC handlers, or UI. Truth is re-encoded as hardcoded string sets, name comparisons, or name-based guards that duplicate (and silently drift from) the authoritative provider metadata.

---

## P0 Findings (broken or data-integrity risk)

### P0-1: `SINGLETON_PROVIDERS` hardcoded in ComputeRepository

**Location** — `packages/core/repositories/compute.ts:63` (`const SINGLETON_PROVIDERS = new Set(["local"]);`) and `:94-108` (enforcement branch).

**The flaw** — The repo-layer uniqueness constraint is driven from a local string set. The `ComputeProvider` interface already exposes `readonly singleton?: boolean` (`packages/compute/types.ts:86`) and `LocalProvider` sets it correctly (`packages/compute/providers/local/index.ts:54`). Every other provider omits the flag (undefined -> falsy), so the capability truth already lives on the provider registry -- the repo just refuses to look at it.

**Why it's wrong** — If a future provider ships `singleton = true` (e.g. a hypothetical `host` or `workstation` provider), the constraint will silently fail and the table will accept two rows. Conversely, renaming `LocalProvider.name` or adding `local-arkd` as a distinct registration would drop the singleton guard even though `LocalProvider.singleton` still says true. The two sources of truth WILL diverge.

**Recommended fix shape** — Repo takes a `ProviderRegistryPort` (or a `ProviderCapabilityQuery` function) via constructor / DI, and the create() method calls `registry.get(provider)?.singleton === true` instead of the string set. The registry already hangs off `AppContext` (`packages/core/app.ts:631`), so a minimal `isSingleton(name): boolean` accessor on the port is enough. No new RPC surface needed -- this is an internal capability query.

**Local vs control-plane parity** — The repository is shared across both dialects via drizzle (`CLAUDE.md`: schema-as-code, both dialects), so parity is accidentally preserved today. `ControlPlaneComputeStore` (`packages/core/adapters/control-plane/compute-store.ts`) is a `NOT_MIGRATED` stub; when it ships it must re-implement the same rule -- unless the rule is moved up to a service that sits above both stores.

**Severity**: P0 — the hardcoded set is a correctness drift waiting to happen the moment a second singleton provider lands, and the sibling `.delete()` guard at `:213` (next finding) demonstrates the string-based approach is already mis-wired.

---

### P0-2: `ComputeRepository.delete()` uses compute-row NAME as the protection key

**Location** — `packages/core/repositories/compute.ts:213` (`if (name === "local") return false;`).

**The flaw** — The delete guard filters by the literal row name `"local"`, not by the provider. This conflates two orthogonal things: (a) "this compute target has the well-known default name 'local'" and (b) "this provider doesn't support deletion" (which is what `provider.canDelete` is supposed to encode). `LocalProvider.canDelete = false` (`packages/compute/providers/local/index.ts:60`) carries the real intent.

**Why it's wrong** — Concrete bug paths, both user-reachable:
- User creates an EC2 compute and names it `"local"` (nothing forbids this). Deletion is silently refused, orphaning the row.
- User creates a second `local`-provider row named `"home"` (possible if P0-1 regresses, or if the row was created before `SINGLETON_PROVIDERS` was added). Deletion succeeds, even though `LocalProvider.canDelete = false`.

**Recommended fix shape** — Look up the row, resolve the provider, reject if `provider.canDelete === false`:
```ts
const compute = await this.get(name);
if (!compute) return false;
const provider = this.registry.get(compute.provider);
if (provider?.canDelete === false) return false;
```
The method already has to resolve the row shortly anyway for cascade concerns. The name-based guard should be deleted.

**Local vs control-plane parity** — Same shared repo; the hosted stub will repeat the bug when it lands.

**Severity**: P0 — the current guard both under-protects (name collisions bypass it) and over-protects (it lets through local rows with any other name), and the authoritative flag is sitting right there unread.

---

### P0-3: `initialStatus` hardcoded in repo, ignores provider declaration

**Location** — `packages/core/repositories/compute.ts:111` (`const initialStatus: ComputeStatus = provider === "local" ? "running" : "stopped";`).

**The flaw** — The `ComputeProvider` interface declares `readonly initialStatus: string` (`packages/compute/types.ts:90`) and every provider sets it explicitly (`LocalProvider`: `"running"`, `EC2`/`K8s`/`Docker`/`remote-arkd`: `"stopped"`). The repo branches on provider name and hardcodes the same mapping instead of reading the field.

**Why it's wrong** — When a new provider ships -- say `KataProvider` with `initialStatus: "provisioning"`, or a `LocalSnapshot` provider that should boot in `"stopped"` -- the repo will write the wrong row status because it defaults to `"stopped"` for anything not named `"local"`. The provider's declaration is effectively dead.

**Recommended fix shape** — Same as P0-1: look up the provider from the registry and use `provider.initialStatus`. Fall back to `"stopped"` only if the provider is unknown (a legitimate safety net for legacy rows).

**Local vs control-plane parity** — Shared repo path, parity-safe today, will drift identically in both.

**Severity**: P0 — status field drives UI rendering (running vs stopped badge), reconciliation, and the `ComputeActions` start/stop button visibility. Wrong initial status = user-visible wrong state immediately after create.

---

## P1 Findings (break when a new provider/runtime/connector lands)

### P1-1: `canReboot` / `canDelete` / `needsAuth` declared on every provider but never read

**Location** — `packages/compute/types.ts:86-91` defines the flags; implementations in `packages/compute/providers/{local,docker,k8s,local-arkd,remote-arkd}/*.ts` set them. Production consumers (verified by `grep -r "\.canReboot|\.canDelete|\.needsAuth" packages/`): **zero non-test reads**.

**The flaw** — These flags are pure dead metadata. The `compute/reboot` handler (`packages/server/handlers/resource.ts:500`) checks `provider?.reboot` (method presence) rather than `provider.canReboot` (capability flag). `compute/destroy` (`:481`) doesn't check `canDelete` at all -- it just calls `provider.destroy()` and relies on the provider throwing (e.g. `LocalProvider.destroy()` -- `packages/compute/providers/local/index.ts:74-76` -- throws `"Cannot destroy the local compute"`). `needsAuth` has no consumer anywhere.

**Why it's wrong** — (a) Capability queries the UI should be able to ask (`canDelete` to hide the Destroy button, `canReboot` to hide Reboot, `needsAuth` to prompt for credentials) currently have no answer, which forces UI-side hardcoded conditionals -- see P1-3. (b) The "method presence means supported" proxy for `canReboot` breaks if a provider defines `reboot()` that just throws NotSupported. (c) The "throw from destroy" proxy for `canDelete` surfaces as a runtime error to the user instead of a preventable disabled button.

**Recommended fix shape** — Expose a `compute/capabilities` RPC (or fold the three flags into the existing `compute/read` response) that returns `{ canDelete, canReboot, needsAuth, supportsWorktree, singleton, initialStatus, isolationModes }` sourced from `provider` for the named compute. Server-side, handlers consult the flag before dispatching (`if (!provider.canDelete) throw ErrorCodes.UNSUPPORTED`). UI reads the capability payload and hides disallowed actions. Interface should also make `reboot?()` non-optional and paired with `canReboot: false` when unsupported, so the two declarations can't drift.

**Local vs control-plane parity** — Flags are defined on the provider instance, which is per-AppContext; both modes see the same logic since the provider registry is mode-independent.

**Severity**: P1 — the current "method presence" / "method throws" proxies happen to work for the three providers that ship today, but every new provider will independently rediscover whether to read the flag, define a throwing method, or do both.

---

### P1-2: Connector surface discriminator uses deprecated `kind` field

**Location** — `packages/core/connectors/registry.ts:54` (`if (!c || c.kind !== "mcp" || !c.mcp) continue;`) and `:75` (`if (c?.kind === "context") out.push(c);`).

**The flaw** — The `Connector` interface declares `kind?: ConnectorKind` with the explicit comment (`packages/core/connectors/types.ts:102-108`):
> "Legacy surface discriminator. Optional in the new shape -- surfaces ARE the discriminator. Existing definitions still set this; new definitions may omit it. Scheduled for removal in Wave 4."

But `resolveMcpEntries()` filters on `c.kind !== "mcp"` and `resolveContextConnectors()` filters on `c.kind === "context"`. Any new connector that follows the documented guidance and omits `kind` will be silently dropped from both resolution paths.

**Why it's wrong** — The definitions today (`pi-sage.ts`, `jira.ts`, `github.ts`, etc.) all still carry `kind: "mcp"`, so the bug is latent. But the types file explicitly promises new connectors don't need it, and a new `kind: undefined, mcp: {...}` connector will silently fail to mount -- no error, no log, just no MCP surface.

**Recommended fix shape** — Filter on the surface property, not the discriminator:
```ts
// resolveMcpEntries
if (!c?.mcp) continue;
// resolveContextConnectors
if (c?.context) out.push(c);
```
This matches the "surfaces ARE the discriminator" contract in the types file.

**Local vs control-plane parity** — Shared connector registry, parity-safe.

**Severity**: P1 — breaks the instant someone writes a connector per the documented contract.

---

### P1-3: UI hides compute actions via `compute.provider !== "local"` hardcode

**Location** — `packages/web/src/components/compute/ComputeDetailPanel.tsx:70` (`{compute.provider !== "local" && (<ComputeActions ...`).

**The flaw** — The Actions block (Start/Stop/Destroy) is rendered only when the provider is not literally named `"local"`. This is a UI conditional encoding a backend rule (`LocalProvider.canDelete === false && LocalProvider.initialStatus === "running"` -> nothing useful to do) via a hardcoded name.

**Why it's wrong** — (a) A future provider that has the same "can't delete, always running" semantics (e.g. a managed-host connector) will erroneously show Start/Stop/Destroy buttons that will fail at the server. (b) If `local-arkd` gets registered under a different display name, the actions panel disappears for actual local computes. (c) This is exactly the "never paper over in the UI" pattern the user flagged.

**Recommended fix shape** — Drive the action list from the capability payload (see P1-1). `ComputeActions` already accepts `compute` and could consult a `capabilities` field: render Start only if `canStart`, Stop only if `canStop`, Destroy only if `canDelete`. The backend capabilities RPC from P1-1 is the right source.

**Local vs control-plane parity** — Same web bundle ships for both; UI fix is mode-independent.

**Severity**: P1 — latent until a new "can't delete" provider lands, at which point the UI will lie to the user.

---

### P1-4: UI filter treats unset `compute_name` as "belongs to local" via name/type string check

**Location** — `packages/web/src/components/compute/ComputeDetailPanel.tsx:44` (`(!s.compute_name && (compute.provider === "local" || compute.type === "local"))`).

**The flaw** — Sessions without a `compute_name` are attributed to whichever compute is being viewed iff that compute's `provider === "local"` or `type === "local"`. Two hardcoded strings encode the rule "sessions without an explicit compute are assumed local".

**Why it's wrong** — (a) The convention that "no `compute_name` means local" is a server-side invariant that should be resolved server-side (the dispatcher knows which compute the session ran on; it should fill `compute_name`). Baking it into the UI puts the string `"local"` into two code paths that must stay in sync with whatever the server writes. (b) If local migrates to `local-arkd` as its registered name, this filter silently stops matching.

**Recommended fix shape** — Server fills `compute_name` on every session row at dispatch. UI matches on `s.compute_name === compute.name` only. If the "unattached sessions" rendering is needed as a UX, it should be an explicit `compute_name: null` bucket, not a provider-name special-case.

**Local vs control-plane parity** — Same UI; the server invariant question spans both modes.

**Severity**: P1.

---

### P1-5: `NewComputeForm` duplicates template-lifecycle classification

**Location** — `packages/web/src/components/compute/NewComputeForm.tsx:173-174`:
```ts
const TEMPLATE_COMPUTE_KINDS = new Set(["k8s", "k8s-kata", "firecracker"]);
const TEMPLATE_RUNTIME_KINDS = new Set(["docker", "compose", "devcontainer", "firecracker-in-container"]);
```

**The flaw** — This is a near-verbatim copy of `COMPUTE_KIND_LIFECYCLE` + `RUNTIME_KIND_LIFECYCLE` in `packages/types/compute.ts:36-51`, which is the authoritative source. The comment at line 170 even acknowledges it ("mirror of packages/types/compute.ts"). The `effectiveLifecycle(compute, runtime)` function in the same file already computes the exact boolean the form wants.

**Why it's wrong** — When a new compute kind ships (e.g. `firecracker-bare-metal`) with a lifecycle classification, only the types file gets updated; the UI set silently misclassifies it and auto-flips the form into the wrong Template/Concrete mode (`:198`).

**Recommended fix shape** — Import `effectiveLifecycle` from `packages/types/compute.ts` into the web bundle (or re-export from a shared location) and call `effectiveLifecycle(compute, runtime) === "template"` directly. Delete the two sets.

**Local vs control-plane parity** — Shared UI; the lifecycle tables are shared too.

**Severity**: P1 — correct today, drifts the moment a new kind lands.

---

## P2 Findings (ugly but correct)

### P2-1: CLI compute.ts branches on `opts.provider === "k8s"` / `"k8s-kata"` for interactive prompts

**Location** — `packages/cli/commands/compute.ts:186` (`if ((opts.provider === "k8s" || opts.provider === "k8s-kata" || newCompute === "k8s") && !opts.fromTemplate) { await promptK8sIfNeeded(opts); }`).

**The flaw** — Interactive prompt is triggered by a hardcoded set of provider names. The per-provider flag-spec (`packages/compute/flag-specs/`) is already the abstraction that declares per-provider CLI surface; `promptK8sIfNeeded` should probably live behind a `spec.promptIfIncomplete?(opts)` method on the flag spec.

**Why it's wrong** — When a new provider ships with required interactive fields, a new `||` branch gets added to this conditional. Over time this grows into a provider-name-dispatched switch in a layer that's supposed to be provider-agnostic.

**Recommended fix shape** — Add `promptInteractive?: (opts) => Promise<void>` to `ProviderFlagSpec`. Replace the conditional with `await spec?.promptInteractive?.(opts);`.

**Local vs control-plane parity** — CLI only runs in local mode; control-plane has no CLI concept.

**Severity**: P2 — correct today, minor code-smell that grows linearly with provider count.

---

## Cross-cutting patterns

1. **Capability flags declared but never read.** The `ComputeProvider` interface ships `singleton`, `canReboot`, `canDelete`, `needsAuth`, `initialStatus` on every implementation. Production consumers read only `supportsWorktree` (3 call sites) and `isolationModes` (1). The remaining five flags are dead metadata that every new provider dutifully implements while the real decisions happen elsewhere as hardcoded string checks. This is the single biggest pattern; fixing P0-1/P0-2/P0-3/P1-1 in one pass closes it.

2. **UI re-encoding backend rules as string-name conditionals.** The Web layer has three such sites (`ComputeDetailPanel.tsx:44`, `:70`, `NewComputeForm.tsx:173-174`) and each one is a copy of a backend truth table. The correct shape is server-side capability payloads on the read endpoints; the UI renders what the server says is allowed.

3. **Method-presence as a capability proxy.** `compute/reboot` handler checks `provider?.reboot` existence instead of `provider.canReboot`. This works only because the interface made `reboot?()` optional. A provider can't declare "I theoretically support reboot but not in this configuration" with the current shape -- the flag would let it, method-presence doesn't.

4. **The repository layer owning provider-aware rules.** `ComputeRepository` pokes at provider semantics (singleton, initial status, delete guard) without a dependency on the provider registry. Either the rules move up into `ComputeService` (which can inject the registry cleanly) or the repo gains a typed `ProviderCapabilityQuery` dependency. Both are better than string-set duplicates.

5. **Control-plane parity is currently accidental.** Because `ComputeRepository` is dual-dialect drizzle, the singleton check runs for both SQLite and Postgres identically. `ControlPlaneComputeStore` is a `NOT_MIGRATED` stub; when it ships, every rule currently in `ComputeRepository` MUST be re-enforced there, OR the rules move above the store abstraction. Moving the rules up is the right call -- it's the only way to prevent silent drift.

---

## Recommended remediation order

1. **P0-1 + P0-2 + P0-3 together.** Introduce a `ProviderCapabilityPort` on `ComputeService` (or inject the registry into `ComputeRepository`). One pass replaces the hardcoded set, the name-based delete guard, and the `initialStatus` ternary. Tests already exist (`packages/core/services/__tests__/compute.test.ts:45`, `packages/core/repositories/__tests__/compute.test.ts:31`) -- they should keep passing after the refactor, and a new test should cover a second hypothetical singleton provider to prove the rule is metadata-driven.
2. **P1-1.** Expose `compute.capabilities` on the read RPC (or add a dedicated capability endpoint). Handlers (`compute/reboot`, `compute/destroy`) consult `canReboot` / `canDelete` before dispatch; this also tightens the error surface from "provider threw" to "server refused 400-style".
3. **P1-3 + P1-4.** Replace the two `ComputeDetailPanel` string checks with consumers of the capability payload from step 2.
4. **P1-2.** Flip connector resolution to filter on surface presence (`c.mcp`, `c.context`) instead of `c.kind`. Trivial diff; pairs with the types file's own deprecation note.
5. **P1-5.** Import `effectiveLifecycle` into the Web bundle, delete the duplicate sets.
6. **P2-1.** Defer until after a second provider grows interactive prompts. Low-value refactor until then.
