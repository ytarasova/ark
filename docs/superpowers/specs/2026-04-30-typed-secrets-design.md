# Typed Secrets -- Design Spec

## Goal

Replace Ark's untyped `(name, value)` / `(name, files)` secret model and the implicit `~/.ssh` rsync that EC2 sessions rely on with a **typed-secret** model where every secret declares what shape it is, the dispatch layer auto-attaches all tenant secrets to every session, and per-provider placement code knows where each type belongs on each medium. Drives the immediate need (run sessions on EC2 against `git@bitbucket.org:paytmteam/...` repos without leaking the laptop's `~/.ssh` and without `bitbucket.org` missing from `known_hosts`) and the structural one (a credential-delivery model that scales past the hardcoded claude-subscription path).

## Context

### What exists today

- **Storage** (`packages/core/secrets/types.ts`) -- two namespaces: string secrets (`[A-Z0-9_]+`) and blobs (`[a-z0-9][a-z0-9-]{0,62}`, `Record<string, Uint8Array>`). Two backends: `FileSecretsProvider` (local, encrypted `secrets.json`) and `AwsSecretsProvider` (SSM Parameter Store).
- **Dispatch-time injection** (`packages/core/services/dispatch/secrets-resolve.ts`) -- stage / runtime YAML lists `secrets: [NAME]`; resolver fetches values and adds them to `LaunchEnvResult.env`. String secrets only.
- **Hardcoded blob path** (`packages/core/services/dispatch-claude-auth.ts`) -- a tenant's `claude` subscription blob is materialised as a per-session k8s `Secret`, then K8sProvider mounts it at `/root/.claude`. Only k8s implements this; `arkd-backed.ts:39` declares `supportsSecretMount = false`.
- **EC2 implicit rsync** (`packages/compute/providers/ec2/sync.ts:50`) -- `~/.ssh/`, `~/.aws/`, `~/.gitconfig`, the `gh` token, and `~/.claude/` are pushed to every EC2 box at provision time. `ssh-keyscan github.com` is hardcoded; `bitbucket.org` is not.

### Problems

1. **Bitbucket sessions fail on EC2.** Host-key check rejects `git@bitbucket.org:...` because `known_hosts` only contains GitHub.
2. **Implicit `~/.ssh` rsync is unscoped.** Every EC2 session receives every key on the user's laptop, not just the one needed. No per-tenant boundary, no audit trail, no rotation story.
3. **Claude blob is the only typed credential, and its handling is hardcoded.** Adding any other credential (kubeconfig, deploy key, AWS profile) requires bespoke code on every provider that should consume it.
4. **`supportsSecretMount = false` on every non-k8s provider.** EC2 has no equivalent of the k8s Secret mount, so even `ark secrets blob upload` does nothing useful for the dominant compute backend.

### Non-goals for v1

- Per-secret ACLs or per-session opt-out beyond the existing stage / runtime narrowing list.
- Migrating the existing implicit `~/.aws/`, `~/.gitconfig`, `gh auth` syncs in `ec2/sync.ts` -- those stay as-is in v1; only credential placement moves to typed secrets.
- A web UI for typed secrets. CLI is the only interface.
- New cloud-host integrations (HashiCorp Vault, AWS Secrets Manager beyond the existing SSM backend).

---

## Design decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Schema shape | Single `type` field + arbitrary `metadata: Record<string,string>` map | Avoids a fixed role taxonomy; per-type placer reads only the metadata keys it cares about. |
| Binding model | Auto-attach all tenant secrets to every session | Matches the existing implicit rsync's behaviour but scoped per-tenant + per-type + audited. Operator chose this knowingly accepting "every session sees every credential". |
| Backwards-compat with YAML `secrets: [NAME]` lists | Narrowing filter | If a stage / runtime declares the list, only those names land. Without a list, all tenant secrets land. Two modes coexist; sensitive flows can opt in to narrowing. |
| v1 type taxonomy | `env-var`, `ssh-private-key`, `generic-blob`, `kubeconfig` | `env-var` covers all existing string secrets. `ssh-private-key` is the motivating case. `generic-blob` is the existing claude path generalised. `kubeconfig` lives only on the k8s provisioner config slot. |
| v1 provisioner coverage | EC2, k8s, local, docker, firecracker | Operator picked all five so the abstraction is uniform. Most cells are small or no-op. |
| Architecture | Per-type placer + per-provider `PlacementCtx` (verb-based interface) | N + M scaling, conventional shape, no data-pipeline indirection. Maps onto existing `sshExec` / `rsyncPush` style in `ec2/sync.ts`. |
| `ssh-keyscan` execution | Control plane (placer side) | Placer runs `ssh-keyscan` once per host, ships bytes to the provider as part of `appendFile`. Same code path on every provider. |
| `kubeconfig` placement target | k8s provisioner-config only | Not a session secret; consumed by the k8s API client itself when a compute is launched. EC2 / local / docker / firecracker placers are explicit no-ops. |

---

## Architecture

### Schema

```ts
// packages/core/secrets/types.ts
export type SecretType = "env-var" | "ssh-private-key" | "generic-blob" | "kubeconfig";

export interface SecretRef {
  tenant_id: string;
  name: string;
  type: SecretType;                  // NEW. Defaults to "env-var" / "generic-blob" on legacy reads.
  metadata: Record<string, string>;  // NEW. Always present; empty object when unused.
  description?: string;
  created_at: string;
  updated_at: string;
}
```

`SecretsCapability` keeps its current method signatures. The implementations widen the persisted shape:

- **`FileSecretsProvider`** -- read-side back-compat: missing `type` reads as `env-var` for string entries, `generic-blob` for blob entries. Missing `metadata` reads as `{}`. No file rewrite on first read; `set` / `setBlob` write the new shape going forward.
- **`AwsSecretsProvider`** -- `Description` becomes a JSON envelope `{description, type, metadata}`. Plain-text legacy descriptions are honoured as `description` only and the type / metadata defaults apply.
- **DB schema** -- no change. Secrets and blobs are not tracked in the DB; the file provider's `~/.ark/secrets.json` and the SSM backend are the canonical stores. The `version` field of `secrets.json` is bumped from `1` to `2` to signal the shape change; a v1 file is upgraded read-side on first load and rewritten in v2 on the next `set`.

### Per-type placer + per-provider `PlacementCtx`

```ts
// packages/core/secrets/types.ts
export interface PlacementCtx {
  /** Write a file on the target. Mode is bit-exact (placer chooses). */
  writeFile(path: string, mode: number, bytes: Uint8Array): Promise<void>;

  /** Append a marker-keyed block to a file, replacing any prior block with the same marker. */
  appendFile(path: string, marker: string, bytes: Uint8Array): Promise<void>;

  /** Set an env var that lands on the agent launcher. */
  setEnv(key: string, value: string): void;

  /** Configure the provisioner itself (k8s consumes kubeconfig; others ignore). */
  setProvisionerConfig(cfg: { kubeconfig?: Uint8Array }): void;

  /** Expand a "~/foo" path to the medium's actual home, e.g. /home/ubuntu/foo on EC2. */
  expandHome(rel: string): string;
}

export interface TypedSecretPlacer {
  place(secret: TypedSecret, ctx: PlacementCtx): Promise<void>;
}
```

```ts
// packages/core/secrets/placers/ssh-private-key.ts (sketch)
export const sshPrivateKey: TypedSecretPlacer = {
  async place(secret, ctx) {
    requireMetadata(secret, ["host"]);
    const hosts = [secret.metadata.host, ...(secret.metadata.aliases?.split(",") ?? [])];
    const knownHosts = await runKeyScan(hosts);

    const keyPath = ctx.expandHome(`~/.ssh/id_${secret.name.toLowerCase()}`);
    await ctx.writeFile(keyPath, 0o600, secret.bytes);

    await ctx.appendFile(
      ctx.expandHome("~/.ssh/config"),
      `ark:secret:${secret.name}`,
      Buffer.from(buildSshConfigBlock(secret, keyPath)),
    );
    await ctx.appendFile(
      ctx.expandHome("~/.ssh/known_hosts"),
      `ark:secret:${secret.name}`,
      knownHosts,
    );
  },
};
```

### Central dispatch

`packages/core/secrets/placement.ts` -- replaces `dispatch-claude-auth.ts`:

```ts
async function placeAllSecrets(app, session, compute, ctx: PlacementCtx) {
  const all = await loadTenantSecrets(app, session.tenant_id);    // list + listBlobs
  const narrow = computeNarrowingFilter(session, runtime, stage); // YAML secrets: lists
  const selected = narrow ? all.filter(s => narrow.has(s.name)) : all;

  for (const s of selected) {
    const placer = PLACERS[s.type];
    if (!placer) { logSkip(s, "unknown_type"); continue; }
    try {
      await placer.place(s, ctx);
      logPlaced(s, compute);
    } catch (e) {
      handleByPolicy(s.type, e, s);  // fail-fast vs warn-and-continue per type
    }
  }
}
```

Failure policy by type:

- `env-var`, `ssh-private-key`, `kubeconfig` -- fail-fast. The session is broken without these.
- `generic-blob` -- warn-and-continue. Matches today's claude-blob behaviour: an api-key tenant runs fine without `~/.claude`.

---

## Per-type placement contracts

### `env-var`

| Field | Value |
|---|---|
| Storage | string secret |
| Required metadata | none |
| Optional metadata | none in v1 |
| Placement | `ctx.setEnv(secret.name, secret.value)` |
| Provider variation | none -- identical on every provider |
| Failure mode | fail-fast |

Single placer file. Five lines. Covers every existing string secret post-migration.

### `ssh-private-key`

| Field | Value |
|---|---|
| Storage | string secret (PEM body) |
| Required metadata | `host` |
| Optional metadata | `aliases` (comma-separated extra hostnames), `target_path` (override default `~/.ssh/id_<name-lowercased>`), `username` (default `git`) |
| Placement | `writeFile(target_path, 0o600, bytes)` + `appendFile(~/.ssh/config, marker, configBlock)` + `appendFile(~/.ssh/known_hosts, marker, ssh-keyscan output)` |
| Provider variation | None at the placer layer. Provider ctx implements the verbs in its medium-specific way. |
| Failure mode | fail-fast |

`buildSshConfigBlock` emits:

```
# BEGIN ark:secret:<name>
Host <host> [<aliases ...>]
  IdentityFile <target_path>
  IdentitiesOnly yes
  User <username>
# END ark:secret:<name>
```

`appendFile`'s marker semantics: if a `# BEGIN ark:secret:<name>` ... `# END ark:secret:<name>` block already exists in the file, the provider replaces it in place. Idempotent across re-dispatches.

### `generic-blob`

| Field | Value |
|---|---|
| Storage | blob namespace |
| Required metadata | `target_path` (e.g. `~/.claude`, `~/.config/myapp`) |
| Optional metadata | `mode` (file mode, default `0o400`), `owner` (uid:gid for ec2/local/docker; ignored on k8s) |
| Placement | for each `(filename, bytes)` in the blob: `writeFile(<target_path>/<filename>, mode, bytes)` |
| Provider variation | k8s implements `target_path`-rooted writeFile by accumulating into a per-session Secret + projected volume mount at `target_path`; others write files directly. |
| Failure mode | warn-and-continue |

`target_path` is the *complete* destination directory; existing contents are replaced, not merged. The placer never mutates files outside `target_path`.

### `kubeconfig`

| Field | Value |
|---|---|
| Storage | string secret (kubeconfig YAML) |
| Required metadata | none |
| Optional metadata | `context` (sets `current-context` field of the YAML at placement time, in-process; no `kubectl`) |
| Placement (k8s provider) | `ctx.setProvisionerConfig({kubeconfig: bytes})` -- consumed by the k8s API client when launching the session pod |
| Placement (other providers) | `ctx.setProvisionerConfig` is a no-op; placer logs `secret_skipped: not_consumed_by_provider` |
| Failure mode | fail-fast (only on k8s where it has effect) |

If `metadata.context` is set, the placer parses the YAML, rewrites `current-context:`, and re-emits before passing to `setProvisionerConfig`. The `yaml` package is already a dep.

---

## Per-provider `PlacementCtx` implementations

```
packages/core/secrets/
  placers/
    env-var.ts                     # ~5 lines
    ssh-private-key.ts             # ~30 lines
    generic-blob.ts                # ~15 lines
    kubeconfig.ts                  # ~10 lines
  placer-helpers.ts                # runKeyScan, buildSshConfigBlock, rewriteKubeconfigContext
  placement.ts                     # central dispatch loop
  types.ts                         # PlacementCtx interface, TypedSecret, SecretType

packages/compute/providers/
  ec2/placement-ctx.ts             # tar|sshExec for writeFile, sed-block-replace for appendFile
  k8s/placement-ctx.ts             # accumulates into per-session Secret + projected volume mount
  local/placement-ctx.ts           # fs.writeFile under ~/.ark/sessions/<id>/, env merged in-process
  docker/placement-ctx.ts          # writes to session-scoped host dir, bind-mounted at launch
  firecracker/placement-ctx.ts     # writes to rootfs overlay path before VM boot
```

### EC2

- `writeFile(path, mode, bytes)` -- one `tar c | ssh "tar x -C /"` per call (handles arbitrary paths, mode preserved by tar). Mode set explicitly post-write via `chmod` for safety.
- `appendFile(path, marker, bytes)` -- one `sshExec` running a sed expression keyed on `# BEGIN ark:secret:<marker>` / `# END ark:secret:<marker>`: deletes any existing block with the same marker, then appends the new block. Idempotent.
- `setEnv(k, v)` -- accumulates into `this.env`; the dispatcher merges into `LaunchEnvResult.env`.
- `setProvisionerConfig` -- no-op + log.
- `expandHome("~/foo")` -- returns `/home/ubuntu/foo` (REMOTE_HOME constant).
- The existing `syncSshPush` in `packages/compute/providers/ec2/sync.ts:50-67` is **deleted**. `syncAwsPush` / `syncGitPush` / `syncGhPush` / `syncClaudePush` stay (they are environment bootstrap, not credential placement, and remain in scope of the existing implicit-sync model for v1; flagged for v2).

### k8s

- `writeFile(path, mode, bytes)` -- accumulates into `this.secretData[encodeKey(path)] = bytes` and remembers `(path, mode)` for the `defaultMode` / per-key mode overrides on the projected volume spec.
- `appendFile(path, marker, bytes)` -- accumulates into the same `secretData` keyed as `<path>::<marker>`; flush phase merges all entries with the same `path` into one concatenated key, deduped by marker, and the volume mount's `subPath` projection delivers a single merged file.
- `setEnv(k, v)` -- accumulates; merged into the pod spec's `env`.
- `setProvisionerConfig({kubeconfig})` -- replaces the `kc.loadFromFile(cfg.kubeconfig) / kc.loadFromDefault()` branch in `packages/compute/providers/k8s.ts:200-202` with `kc.loadFromString(bytes.toString())` when a kubeconfig was placed. K8s already builds its KubeConfig at launch time (line 188), so the injection point is the existing one; only the source changes. Only k8s implements this verb non-trivially.
- `expandHome("~/foo")` -- returns `/root/foo` for the default Ark image; configurable via compute config when a different home is used.
- Flush phase runs once at end of placement: `applyPerSessionSecret(secretData)` via `@kubernetes/client-node`, then `mergeConfig(compute.name, {secretMounts: [...]})` so `K8sProvider.launch` mounts the Secret at the right paths. Replaces the existing single-purpose `credsSecretName` field; `credsSecretName` is kept as an alias for back-compat but read from `secretMounts[0]` in v1.
- Per-session GC: Secret is labelled `ark.dev/session=<id>` (existing convention); teardown deletes by label.

### Local

- `expandHome("~/foo")` returns `<arkDir>/sessions/<sessionId>/home/foo`. Placer never writes to the user's real `~/.ssh/`.
- `writeFile` / `appendFile` -- direct `fs.promises.writeFile` / read-modify-write with marker-block replacement.
- The launcher exports `HOME=<arkDir>/sessions/<sessionId>/home` plus `unset SSH_AUTH_SOCK` so the agent's git client uses the session-scoped `~/.ssh/` exclusively.
- Cleanup on session teardown: `rm -rf <arkDir>/sessions/<sessionId>/home`.

### Docker

- Same shape as Local, except the writes target a host-side dir that is bind-mounted into the container at `$HOME` (resolved via the container's user record).
- `expandHome("~/foo")` returns the *host-side* path (where the placer writes). The bind-mount means the container sees it at its own `$HOME/foo`.

### Firecracker

- Writes into the per-VM rootfs overlay directory before VM boot. `expandHome` returns the in-overlay path.
- After overlay is finalised, VM boot mounts it as `/`; agent process sees files at the expected `~/.ssh/...` paths.

---

## Migration

1. **`secrets.json` version bump** -- from `version: 1` to `version: 2`. v1 files load with read-side defaults (missing `type` -> `env-var` for strings, `generic-blob` for blobs; missing `metadata` -> `{}`). The next `set` writes the file in v2 shape. No drizzle migration is required (secrets are not in the DB).
2. **`FileSecretsProvider` (`secrets.json`)** -- read-side defaults handle missing fields; `set` / `setBlob` write the new shape from this point on. No bulk rewrite.
3. **`AwsSecretsProvider` (SSM)** -- `Description` envelope upgrade. Plain-text legacy `Description` is read as `description` only.
4. **Claude subscription path** -- `dispatch-claude-auth.ts` is **deleted**. The existing tenant claude blob becomes a `generic-blob` typed secret with `metadata.target_path = ~/.claude` and `metadata.mode = 0o400`. The migration auto-tags any blob whose name matches the tenant claude binding so existing tenants do not need to re-upload. The k8s `generic-blob` placer reproduces the existing semantics (per-session Secret labelled `ark.dev/session=<id>`, mounted at `/root/.claude`) by virtue of the new general path.
5. **`runtimes/*.yaml` and stage YAML `secrets:` lists** -- unchanged. They become the narrowing filter (already designed in §3 of decisions).
6. **`packages/compute/providers/ec2/sync.ts:syncSshPush`** -- removed. The function and its call site in the EC2 sync orchestration are deleted; their behaviour is replaced by per-secret typed placement on every dispatch.

No breaking changes for existing tenants. Existing secrets continue to work; new secrets land typed.

---

## Security and audit

- **Audit events** -- two structured-log event names: `secret_placed` and `secret_unplaced`. Payload: `{tenant_id, secret_name, secret_type, provider, target_path?, session_id, marker?}`. Bytes are never logged. `target_path` is logged only after `expandHome`.
- **Filename / path traversal** -- `BLOB_FILE_RE` already covers blob filenames. For `metadata.target_path` we add a same-shape check that rejects `..`, NUL, CR/LF, and any absolute path outside `~/.<...>`. The CLI rejects on `set`; the placer rejects on dispatch as defence in depth.
- **Mode enforcement** -- placers always pass explicit modes (`0o400` for keys, `0o600` for ssh `config` / `known_hosts`, `0o400` for kubeconfig content, `0o400` default for `generic-blob`). The provider's `writeFile` honours the mode bit-exactly: k8s via volumeMount `defaultMode` / per-key modes, others via post-write `chmod`.
- **Per-session scoping** -- k8s Secrets are labelled `ark.dev/session=<id>` and GC'd on teardown; EC2 file paths land under `expandHome("~/.ssh/")` and are owned by the session's user; local / docker / firecracker write under `<arkDir>/sessions/<id>/home/` which is wiped on teardown.
- **`ssh-keyscan` egress** -- placer runs `ssh-keyscan <host>` on the control plane. In hosted mode the control-plane container needs egress to common git hosts; documented as a deployment requirement. Timeout configurable via `ARK_KEYSCAN_TIMEOUT_MS`, default 5000ms; on timeout the placer logs and proceeds with no `known_hosts` entry (the session will fail loudly at the first git op rather than hanging dispatch).
- **Per-secret ACLs** -- explicit non-goal for v1. Auto-attach-all-tenant-secrets trusts the tenant boundary.

---

## Testing strategy

Per-layer unit + integration coverage. No real cloud calls in CI.

### Per-type placer unit tests

`packages/core/secrets/__tests__/placers.test.ts` -- one test file with subgroups per type. `MockPlacementCtx` records every method call in order with arguments; placer test feeds in a typed secret + asserts the exact call sequence + arg shapes. Coverage per type:

- `env-var` -- happy path, empty value (rejected at CLI, not placer level).
- `ssh-private-key` -- happy path with `host` only; with `aliases`; with `target_path` override; with `username` override; missing `host` (placer throws `RequiredMetadataMissing`); empty `bytes` (rejected); marker idempotency (`appendFile` called twice with same marker).
- `generic-blob` -- happy path multi-file; missing `target_path`; empty blob; mode override.
- `kubeconfig` -- happy path on a provider whose ctx implements `setProvisionerConfig`; with `context` rewrite (parses, rewrites, re-emits as YAML round-trip); on a no-op provider (asserts skip log).

### Helper unit tests

`packages/core/secrets/__tests__/placer-helpers.test.ts`:

- `runKeyScan` -- mocked subprocess; multiple hosts; timeout path; failure path.
- `buildSshConfigBlock` -- string snapshot for each metadata permutation.
- `rewriteKubeconfigContext` -- YAML round-trip preserving comments and formatting.

### Per-provider PlacementCtx tests

One file per provider under each provider's existing test dir.

- **EC2** (`packages/compute/providers/ec2/__tests__/placement-ctx.test.ts`) -- mock `sshExec` and `rsyncPush`. Each verb (`writeFile`, `appendFile`, `setEnv`, `setProvisionerConfig`, `expandHome`) gets at least one test. Marker-block replacement is tested with a fixture file containing a stale block.
- **k8s** (`packages/compute/providers/k8s/__tests__/placement-ctx.test.ts`) -- mock `@kubernetes/client-node`. Tests assert the right Secret resource is constructed (data keys, labels, mode), the right pod-spec patch is emitted, and `setProvisionerConfig` swaps the API client.
- **Local** (`packages/compute/providers/local/__tests__/placement-ctx.test.ts`) -- writes go to a temp arkDir; assertions are filesystem-side (`fs.stat` mode bits, `fs.readFile` content).
- **Docker / Firecracker** -- one file each; same shape as Local with provider-specific path expansions.

### Integration test

`packages/core/secrets/__tests__/placement.integration.test.ts` -- boots `AppContext.forTestAsync()`, registers a fake provider whose `PlacementCtx` records all calls, sets up tenant secrets of every v1 type, runs `placeAllSecrets`, asserts every placer fired with the right artifacts in the right order. Also covers narrowing-filter behaviour (with and without `secrets:` list) and failure-policy behaviour (one `env-var` resolution failure aborts dispatch; one `generic-blob` failure logs and continues).

### Migration regression

`packages/core/secrets/__tests__/migration.test.ts` -- load a legacy `secrets.json` without `type` / `metadata`, assert read returns `env-var` / `generic-blob` defaults; write a new typed secret, reload, assert round-trip; load a legacy SSM `Description` plain-text value, assert read returns `description` populated and `type` defaulted.

### Backwards-compat e2e

`packages/core/secrets/__tests__/claude-subscription.compat.test.ts` -- boots an app with an existing claude subscription blob (no `type` set), tagged via the migration's auto-tagger as `generic-blob` with `metadata.target_path = ~/.claude`. Asserts the k8s `generic-blob` placer mounts at `/root/.claude` with the same Secret name pattern + per-session label scheme as the deleted `dispatch-claude-auth.ts` did.

### TDD discipline

Per the operator's instruction: every placer ships with at least one test before its implementation lands. Every provider ctx ships with at least one test for each of the five verbs. The integration test is written against a fake provider before the EC2 / k8s ctx implementations land, so each provider can be checked off independently as its test passes.

---

## Phasing

The feature is one coherent unit, but the work splits into three landable phases:

| Phase | Scope | Lands |
|---|---|---|
| Phase 1 -- Plumbing | Schema migration, `SecretsCapability` shape change, CLI `--type` / `--metadata` flags, central dispatch loop with no real placers (every secret is `env-var`-handled) | All existing tests still pass; existing secrets keep working; new typed secrets can be stored but only `env-var` actually places. |
| Phase 2 -- EC2 unblock | `ssh-private-key` placer, `EC2PlacementCtx`, deletion of `syncSshPush`. k8s + Local + Docker + Firecracker `PlacementCtx` ship as logged no-ops for `ssh-private-key` (they will be filled in during Phase 3). The implicit `~/.ssh` rsync is gone only on EC2; non-EC2 providers retain their existing credential path until Phase 3 replaces it. | Bitbucket EC2 sessions work end-to-end. The motivating user case is unblocked. |
| Phase 3 -- Generalise | `generic-blob` placer (replaces `dispatch-claude-auth.ts`), `kubeconfig` placer, k8s + Local + Docker + Firecracker `PlacementCtx` full implementations, claude-subscription auto-tag migration, deprecation of `credsSecretName`. | Single placement code path on every provider. `dispatch-claude-auth.ts` deleted. |

Each phase has its own implementation plan; this design covers all three.

---

## Open questions

- **Marker collisions across types.** The marker pattern `ark:secret:<name>` is keyed on secret name. If a future type also wants to append-with-marker to the same file, we need a `<type>:<name>` marker. Punted to v2 -- v1 has only `ssh-private-key` doing append.
- **Multi-key conflict on the same `host`.** Two `ssh-private-key` secrets with the same `metadata.host` produce two `Host bitbucket.org` blocks in `~/.ssh/config` -- SSH picks the first match, second is dead weight. Loud warning at `ark secrets set` time + at placement time. Auto-resolution (e.g. `Match exec` or `IdentityFile` ordering) is v2.
- **`expandHome` on Docker when the container's user is non-default.** EC2's `REMOTE_USER = "ubuntu"` (`packages/compute/providers/ec2/constants.ts`) is a fixed constant. Docker and Firecracker do not have an equivalent constant -- arbitrary user images are possible. For Phase 3 we either (a) bake a `homeDir` into the compute config when the image is known, or (b) call `getent passwd` once at provision time and cache the result. Punted for Phase 2 (EC2 only).

---

## Acceptance criteria

A change set lands phase 1 + 2 when:

1. `ark secrets set BB_KEY --type ssh-private-key --metadata host=bitbucket.org < ~/.ssh/id_ed25519` succeeds and `ark secrets describe BB_KEY` shows the type + metadata.
2. `ark session start TEST-EC2 --compute <ec2-template-with-pai-risk-mlops> --remote-repo git@bitbucket.org:paytmteam/pi-event-registry.git --flow quick --param ticket=TEST-EC2-1 --summary "..."` provisions an EC2 instance, places `BB_KEY` at `~/.ssh/id_bb_key` mode 600 with a matching `Host bitbucket.org` block in `~/.ssh/config` and a `bitbucket.org` entry in `~/.ssh/known_hosts`, and the session's git clone of `pi-event-registry` succeeds.
3. The `~/.ssh` rsync in `packages/compute/providers/ec2/sync.ts` is removed; `git clone` of an unrelated repo (e.g. one needing only the laptop's default `id_ed25519`) requires an explicit `ssh-private-key` secret to succeed.
4. All v1 placer + helper + per-provider-ctx unit tests pass under `make test`.
5. The integration test demonstrates auto-attach + narrowing filter + failure policy on a fake provider.
6. The backwards-compat e2e test demonstrates the k8s claude-subscription path produces the same Secret + mount as before the rewrite.

Phase 3 lands when:

7. `dispatch-claude-auth.ts` is deleted; the integration test for the claude path runs through the generic `placement.ts` path.
8. `kubeconfig` typed secret on a k8s compute results in the API client using the supplied kubeconfig instead of the default in-cluster / `~/.kube/config` path.

---

## References

- `packages/core/secrets/types.ts` -- existing `SecretsCapability`
- `packages/core/services/dispatch/secrets-resolve.ts` -- existing env-var injection path
- `packages/core/services/dispatch-claude-auth.ts` -- existing hardcoded blob path (to be deleted in phase 3)
- `packages/compute/providers/ec2/sync.ts:50` -- existing `~/.ssh` rsync (to be deleted in phase 2)
- `packages/compute/providers/k8s.ts:172` -- existing `supportsSecretMount = true` flag (to be removed; replaced by ctx implementation)
- `packages/compute/providers/arkd-backed.ts:39` -- existing `supportsSecretMount = false` (to be removed)
