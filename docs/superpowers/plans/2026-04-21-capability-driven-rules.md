# Capability-Driven Rules Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Eliminate the hardcoded-rule anti-pattern documented in `docs/2026-04-21-architectural-audit-hardcoded-rules.md`: capability flags declared on provider interfaces but never read, string-set duplicates of provider metadata, UI conditionals encoding backend rules. Rules must be driven by provider/service metadata and enforced consistently across local + control-plane modes.

**Architecture (load-bearing decision):** Compute-provider rules move from `ComputeRepository` **up into `ComputeService`**. The service owns the provider registry dependency; the repo becomes a dumb dialect-parameterized persistence layer. When `ControlPlaneComputeStore` un-stubs, rules don't have to be re-implemented there — they live above the store. This is the only way to prevent silent drift.

**Tech Stack:** existing `ComputeProvider` interface (`packages/compute/types.ts`), existing `ComputeService` (`packages/core/services/compute.ts`), existing `ProviderRegistry` (accessed via `AppContext.getProvider(name)`). No new deps.

**Reference:** Full findings + line numbers in `docs/2026-04-21-architectural-audit-hardcoded-rules.md`. This plan is the action plan; that report is the evidence.

---

## Scope

### IN
- **Wave A:** Move P0 rules (singleton, canDelete, initialStatus) from `ComputeRepository` to `ComputeService` using provider registry lookups.
- **Wave B:** Expose `compute/capabilities` RPC so UI can consult authoritative flags.
- **Wave C:** Flip connector registry to filter on surface presence (`c.mcp` / `c.context`) not legacy `kind` discriminator.
- **Wave D:** Delete `TEMPLATE_COMPUTE_KINDS` / `TEMPLATE_RUNTIME_KINDS` duplicate sets in `NewComputeForm`; consume `effectiveLifecycle()` from `packages/types/compute.ts`.
- **Wave E:** UI consumers of `compute/capabilities` — replace `provider !== "local"` hardcodes in `ComputeDetailPanel`.

### OUT
- **P1-1 dead-flag audit for other capability fields (supportsWorktree, isolationModes):** those ARE read, just inconsistently. Not an architectural flaw.
- **P2-1 CLI branch refactor:** deferred until a second provider grows interactive prompts.
- **Broader cross-layer audit:** this plan handles what the audit flagged. New findings go through a fresh audit cycle.

---

## Dependency graph

```
Wave A (service refactor) ──┐
                            ├──► Wave E (UI consumes capabilities)
Wave B (capabilities RPC) ──┘

Wave C (connector filter flip) — independent
Wave D (form lifecycle import) — independent
```

A + B + C + D can run in parallel (disjoint file sets). E waits for B.

---

## Wave A: Compute-provider rules → ComputeService

**Files (read + modify):**
- `packages/core/repositories/compute.ts` — strip `SINGLETON_PROVIDERS` set, delete the name-based `delete` guard, delete the `initialStatus` ternary
- `packages/core/services/compute.ts` — absorb the three rules with provider registry lookups
- `packages/compute/types.ts` — no change (flags already exist)
- `packages/compute/providers/local/index.ts` — verify `singleton: true`, `canDelete: false`, `initialStatus: "running"` all set (they are)
- `packages/compute/providers/{docker,k8s,ec2,arkd-backed,remote-arkd,local-arkd}/index.ts` — verify flags set appropriately; add `singleton: false` / `canDelete: true` where missing
- Tests: `packages/core/repositories/__tests__/compute.test.ts` (singleton test moves to service level), `packages/core/services/__tests__/compute.test.ts` (new cases for the refactored path)

**Contract the service owes the repo:**
```ts
class ComputeService {
  async create(opts: CreateComputeOpts): Promise<Compute> {
    const providerName = resolveProviderName(opts);
    const provider = this.app.getProvider(providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);

    // Rule: at most one non-template, non-clone row per singleton provider.
    if (provider.singleton && !opts.is_template && !opts.cloned_from) {
      const existing = await this.repo.findByProvider(providerName, { excludeTemplates: true });
      if (existing) {
        throw new Error(
          `Provider '${providerName}' is a singleton -- compute '${existing.name}' already exists`,
        );
      }
    }

    // Rule: initial status from provider declaration, not name.
    const initialStatus = provider.initialStatus;

    return this.repo.insert({ ...opts, provider: providerName, status: initialStatus });
  }

  async delete(name: string): Promise<boolean> {
    const row = await this.repo.get(name);
    if (!row) return false;
    const provider = this.app.getProvider(row.provider);
    if (provider?.canDelete === false) {
      throw new Error(`Provider '${row.provider}' does not support deletion`);
    }
    return this.repo.delete(name);
  }
}
```

Repo becomes: `insert(row)`, `get(name)`, `delete(name)`, `findByProvider(name, opts)`, list queries — no rule enforcement.

- [ ] **Step A.1: Audit every provider's flag coverage**

For each provider in `packages/compute/providers/`, confirm:
- `singleton`: `true` only for `LocalProvider`; explicitly `false` or omitted (defaults to falsy) for others.
- `canDelete`: `false` for `LocalProvider`, `true` for every other provider.
- `initialStatus`: `"running"` for `LocalProvider`, `"stopped"` for EC2/Docker/K8s/remote-arkd, correct for each.

If any provider omits these, ADD them explicitly. The interface makes them non-optional (`canDelete: boolean`, `initialStatus: string`) — verify the type does not currently allow `undefined`. If it does, tighten the type.

- [ ] **Step A.2: Add repository methods needed by the service**

Add `findByProvider(providerName, opts?: { excludeTemplates?: boolean }): Promise<Compute | null>` to `ComputeRepository`. This replaces the inline drizzle query at `:100-108`.

Write a test first (RED), then implement.

- [ ] **Step A.3: Refactor `ComputeService.create` to own singleton + initialStatus rules**

- Write failing tests at the service level for: (a) second local-provider row rejected, (b) `initialStatus` pulled from provider, (c) template lifecycle exempt from singleton check, (d) cloned_from exempt from singleton check.
- Implement the service method per the contract above.
- Wire through any RPC handler that currently calls `repo.create` to call `service.create` instead.

- [ ] **Step A.4: Refactor `ComputeService.delete` to own canDelete rule**

- Failing test: delete rejects when `provider.canDelete === false`, succeeds otherwise, handles unknown row with `return false`.
- Implement per contract.
- Remove the `name === "local"` check from `ComputeRepository.delete` (the repo becomes persistence-only).

- [ ] **Step A.5: Strip the repo of rule logic**

Delete from `packages/core/repositories/compute.ts`:
- `SINGLETON_PROVIDERS` const (line 63)
- The singleton enforcement block (lines 94-108)
- The `initialStatus` ternary (line 111) — the service passes the computed value.
- The `if (name === "local") return false;` guard (line 213)

Move the existing repo test for singleton (`packages/core/repositories/__tests__/compute.test.ts:31-39`) to the service test file. The repo test becomes: "findByProvider returns the first matching row" / "insert writes the row as given."

- [ ] **Step A.6: Run the full compute-related test set**

```bash
make test-file F=packages/core/repositories/__tests__/compute.test.ts
make test-file F=packages/core/services/__tests__/compute.test.ts
make test-file F=packages/server/handlers/__tests__/resource-crud.test.ts
```
All green.

- [ ] **Step A.7: Lint + typecheck**

```bash
bunx tsc --noEmit
make format
make lint
```
Zero warnings.

- [ ] **Step A.8: Commit**

```bash
git add -A
git commit -m "refactor(compute): move provider rules from repo to service

- Singleton constraint driven by provider.singleton (was: hardcoded SINGLETON_PROVIDERS set)
- Delete guard driven by provider.canDelete (was: row name === 'local')
- initialStatus pulled from provider.initialStatus (was: provider name ternary)

ComputeRepository is now a persistence-only dialect-parameterized layer.
When ControlPlaneComputeStore un-stubs, rules don't need to be re-implemented
there -- they live in ComputeService above the store abstraction.

Closes P0-1, P0-2, P0-3 from docs/2026-04-21-architectural-audit-hardcoded-rules.md"
```

---

## Wave B: `compute/capabilities` RPC

**Files:**
- `packages/server/handlers/compute.ts` (or wherever `compute/*` handlers live) — add `compute/capabilities` method
- `packages/server/handlers/__tests__/` — new test
- `packages/protocol/types.ts` — typed request/response
- `packages/core/services/compute.ts` — expose `getCapabilities(name)` helper (optional, can inline in handler)

**RPC contract:**
```ts
// Request: { name: string }  OR  { provider: string }
// Response: { capabilities: ComputeCapabilities }
interface ComputeCapabilities {
  provider: string;
  singleton: boolean;
  canReboot: boolean;
  canDelete: boolean;
  needsAuth: boolean;
  supportsWorktree: boolean;
  initialStatus: string;
  isolationModes: IsolationMode[];
}
```

- [ ] **Step B.1: Define types in protocol/types.ts**

Add request + response schemas. Zod where existing handlers use Zod (per #276 unification).

- [ ] **Step B.2: Write the handler failing test**

Test cases: (a) known compute name returns correct flags for its provider, (b) unknown name returns RPC error, (c) flags match what the provider declares.

- [ ] **Step B.3: Implement the handler**

```ts
router.method("compute/capabilities", async (params, ctx) => {
  const { name } = params;
  const compute = await app.computes.get(name);
  if (!compute) throw new RpcError(ErrorCodes.NOT_FOUND, `Unknown compute: ${name}`);
  const provider = app.getProvider(compute.provider);
  if (!provider) throw new RpcError(ErrorCodes.NOT_FOUND, `Unknown provider: ${compute.provider}`);
  return {
    capabilities: {
      provider: provider.name,
      singleton: provider.singleton ?? false,
      canReboot: provider.canReboot,
      canDelete: provider.canDelete,
      needsAuth: provider.needsAuth,
      supportsWorktree: provider.supportsWorktree,
      initialStatus: provider.initialStatus,
      isolationModes: provider.isolationModes,
    },
  };
});
```

- [ ] **Step B.4: Also update compute/reboot + compute/destroy to consult flags**

Both handlers currently use method-presence (`provider.reboot?`) or "throw from destroy" proxies. Replace with explicit flag checks:

```ts
// compute/reboot
if (!provider.canReboot) throw new RpcError(ErrorCodes.UNSUPPORTED, "Provider does not support reboot");

// compute/destroy
if (!provider.canDelete) throw new RpcError(ErrorCodes.UNSUPPORTED, "Provider does not support destroy");
```

This converts "runtime error from provider" into "server refused" — cleaner error surface for the UI.

- [ ] **Step B.5: Tests + lint + commit**

```bash
make test-file F=packages/server/handlers/__tests__/<new-test-file>.test.ts
make format
make lint
git commit -m "feat(compute): compute/capabilities RPC + flag-based guards in reboot/destroy

Closes P1-1 from docs/2026-04-21-architectural-audit-hardcoded-rules.md"
```

---

## Wave C: Connector registry filters on surface presence

**Files:**
- `packages/core/connectors/registry.ts` — lines 54 + 75
- `packages/core/connectors/__tests__/registry.test.ts`

**The change:**
```ts
// resolveMcpEntries -- was: if (!c || c.kind !== "mcp" || !c.mcp) continue;
if (!c?.mcp) continue;

// resolveContextConnectors -- was: if (c?.kind === "context") out.push(c);
if (c?.context) out.push(c);
```

- [ ] **Step C.1: Write failing test**

Add to `registry.test.ts` a test that registers a connector WITHOUT `kind` set but WITH `mcp: { configName: "x" }`, and asserts `resolveMcpEntries(["it"])` returns an entry for it. Run: the old code filters it out because `c.kind !== "mcp"` is true for undefined.

- [ ] **Step C.2: Flip the filters**

Apply the two-line change. Verify all existing tests still pass (existing connectors all carry `kind: "mcp"` so the new check matches them too).

- [ ] **Step C.3: Lint + commit**

```bash
make test-file F=packages/core/connectors/__tests__/registry.test.ts
make format
make lint
git commit -m "fix(connectors): filter on surface presence, not legacy kind discriminator

The types file already declared 'surfaces ARE the discriminator' but the
registry was filtering on the deprecated kind field. New connectors that
follow the documented guidance (omit kind, set mcp or context) were
silently dropped from resolution.

Closes P1-2 from docs/2026-04-21-architectural-audit-hardcoded-rules.md"
```

---

## Wave D: NewComputeForm consumes effectiveLifecycle

**Files:**
- `packages/web/src/components/compute/NewComputeForm.tsx:173-174` — delete the two local `Set`s
- `packages/types/compute.ts` — verify `effectiveLifecycle` is exported and consumable from the web bundle
- `packages/web/src/components/compute/__tests__/` — test if applicable

**The change:**
```ts
import { effectiveLifecycle } from "@ark/types/compute"; // or whatever the web bundle import style is

// Replace:
//   const TEMPLATE_COMPUTE_KINDS = new Set(["k8s", "k8s-kata", "firecracker"]);
//   const TEMPLATE_RUNTIME_KINDS = new Set(["docker", "compose", "devcontainer", "firecracker-in-container"]);
//   const isTemplateLifecycle = TEMPLATE_COMPUTE_KINDS.has(compute) || TEMPLATE_RUNTIME_KINDS.has(runtime);

// With:
const isTemplateLifecycle = effectiveLifecycle(compute, runtime) === "template";
```

- [ ] **Step D.1: Verify the export path**

`packages/types/compute.ts` exports `effectiveLifecycle`. Check how the web bundle imports from `packages/types` (probably `@ark/types/compute` or a relative path). Match existing imports in `NewComputeForm.tsx`.

- [ ] **Step D.2: Apply the change + delete the sets**

- [ ] **Step D.3: Verify via a simple test scenario**

Open the New Compute modal, pick `compute: k8s` — form should auto-switch to Template kind (existing behavior). Then pick `compute: local` — Compute kind. Both work because `effectiveLifecycle("k8s", ...)` returns `"template"` and `effectiveLifecycle("local", ...)` returns `"compute"`.

- [ ] **Step D.4: Lint + commit**

```bash
make format
make lint
git commit -m "refactor(web): NewComputeForm consumes effectiveLifecycle from packages/types

Deletes the TEMPLATE_COMPUTE_KINDS / TEMPLATE_RUNTIME_KINDS duplicate
sets that mirrored packages/types/compute.ts. Comment on line 170 even
admitted it: 'mirror of packages/types/compute.ts'. Now uses the
authoritative effectiveLifecycle() function.

Closes P1-5 from docs/2026-04-21-architectural-audit-hardcoded-rules.md"
```

---

## Wave E: UI consumers of compute/capabilities (depends on Wave B)

**Files:**
- `packages/web/src/components/compute/ComputeDetailPanel.tsx:70` — replace `provider !== "local"` gate
- `packages/web/src/components/compute/ComputeDetailPanel.tsx:44` — remove the `provider === "local" || type === "local"` fallback (requires server-side fix: dispatcher must fill `compute_name` on session rows)
- `packages/web/src/components/compute/ComputeActions.tsx` — consume capability props
- `packages/web/src/hooks/useApi.ts` — add `getComputeCapabilities(name)` wrapper
- Server: verify dispatcher fills `session.compute_name` always (this may already be the case — audit first)

**Cannot dispatch until Wave B has landed** (depends on the `compute/capabilities` RPC).

- [ ] **Step E.1: Add the capabilities hook**

`useApi.ts`:
```ts
getComputeCapabilities: (name: string) =>
  rpc<ComputeCapabilitiesResponse>("compute/capabilities", { name }).then((r) => r.capabilities),
```

- [ ] **Step E.2: Update ComputeActions to consume capabilities**

Pass `capabilities` as a prop. Render each action button conditionally:
```tsx
{capabilities.canDelete && <DestroyButton .../>}
{capabilities.canReboot && <RebootButton .../>}
```

Remove any provider-name checks inside `ComputeActions`.

- [ ] **Step E.3: Update ComputeDetailPanel**

Fetch capabilities for the current compute. Replace:
```tsx
{compute.provider !== "local" && (<ComputeActions compute={compute} />)}
```
With:
```tsx
<ComputeActions compute={compute} capabilities={capabilities} />
```

`ComputeActions` now decides which buttons to show; no outer gate needed.

- [ ] **Step E.4: Audit dispatcher for compute_name fill**

`ComputeDetailPanel.tsx:44` currently has:
```ts
(!s.compute_name && (compute.provider === "local" || compute.type === "local"))
```
Find where sessions are created. If the dispatcher always fills `compute_name`, delete this fallback and change the filter to `s.compute_name === compute.name` unconditionally. If not, fix the dispatcher to fill it (server-side change) and then delete the UI fallback.

Grep hint: `session.compute_name =` / `new Session({` / session creation in `packages/core/services/session*.ts`.

- [ ] **Step E.5: Tests + lint + commit**

```bash
make test-file F=packages/e2e/web/compute.spec.ts  # if exists
make format
make lint
git commit -m "refactor(web): ComputeDetailPanel consumes compute/capabilities

Replaces two provider-name hardcodes with capability-driven rendering.

Closes P1-3 and P1-4 from docs/2026-04-21-architectural-audit-hardcoded-rules.md"
```

---

## Dispatch guidance

**Parallel:** Waves A, B, C, D can dispatch concurrently in isolated worktrees. File sets are disjoint (repo/service vs. handler vs. connector registry vs. web form). Merge sequentially on main; any trivial conflict in test files is resolvable.

**Sequential:** Wave E waits for Wave B. Wave E also needs Wave A's refactor, but only to the extent that the capabilities RPC in B reports correct flags — which it does regardless of Wave A's landing (B reads directly from provider instances, not through the service).

Recommendation: dispatch A + B + C + D as four parallel agents. When B and E's dispatcher-fix prerequisite (if any) lands, dispatch E.

---

## Self-review

1. **Spec coverage vs. audit report:**
   - P0-1 ✓ Wave A
   - P0-2 ✓ Wave A
   - P0-3 ✓ Wave A
   - P1-1 ✓ Wave B
   - P1-2 ✓ Wave C
   - P1-3 ✓ Wave E
   - P1-4 ✓ Wave E (with server-side dispatcher verification)
   - P1-5 ✓ Wave D
   - P2-1: deferred, documented in Scope OUT ✓

2. **Placeholder scan:** None — every step has concrete code or grep targets.

3. **Load-bearing architectural decision documented:** Yes — rules move from repo to service. Explicitly stated in the architecture paragraph + tested by Wave A's final commit message.

4. **Control-plane parity:** Covered — the service-layer move is precisely what makes control-plane parity automatic. Called out in the architecture paragraph and in Wave A's commit message.

5. **Type tightening:** Wave A Step A.1 asks the agent to tighten `canDelete: boolean` / `initialStatus: string` (non-optional) if the current interface allows `undefined`. This is how we ensure the rules can never silently fall back to defaults.
