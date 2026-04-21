# Tenant Claude Auth

Per-tenant binding that picks *how* sessions dispatched on behalf of a
tenant authenticate to Anthropic. Two modes, configured by a tenant admin
and enforced at dispatch time by the Ark daemon.

## The two modes

### Mode 1 -- API key (works in every compute kind)

```bash
# Store the key value (the existing secrets subsystem).
ark secrets set ANTHROPIC_API_KEY

# Bind the tenant to it.
ark tenant auth set acme --api-key ANTHROPIC_API_KEY
```

At dispatch the daemon resolves the secret and injects it as the
`ANTHROPIC_API_KEY` env var into the agent process. Works on `local`,
`docker`, `k8s`, anything -- the agent just reads the env var.

### Mode 2 -- Subscription blob (k8s only, prod path)

Used when you want Ark to authenticate Claude sessions the same way your
laptop does: with the `~/.claude/` directory that `claude login` writes.
Stored as a multi-file "blob" secret in Ark's secrets backend; at dispatch
the daemon materializes it into a per-session Kubernetes Secret and mounts
it into the pod at `/root/.claude`.

```bash
# Upload your ~/.claude directory as a blob secret.
ark secrets blob upload claude-subscription ~/.claude

# Bind the tenant to it.
ark tenant auth set acme --subscription-blob claude-subscription
```

Non-k8s dispatches (docker, local, ec2, ...) ignore the binding -- there's
no pod to mount the Secret into, and those compute kinds already use the
host's `~/.claude` directly.

### Clear the binding

```bash
ark tenant auth clear acme
```

The string secret / blob itself is NOT deleted -- operators usually want
to keep it around for re-binding later. Delete explicitly with
`ark secrets delete` or `ark secrets blob delete`.

### Inspect

```bash
ark tenant auth show acme
#   Kind:       subscription_blob
#   Secret ref: claude-subscription
#   Updated:    2026-04-21T14:22:11.301Z
```

## What happens at dispatch

Before the k8s provider creates the session pod, dispatch runs the
claude-auth materialization step:

1. Read the tenant's `tenant_claude_auth` row.
2. If `kind == "api_key"` -> resolve the string secret, add
   `ANTHROPIC_API_KEY` to the launch env.
3. If `kind == "subscription_blob"` AND compute is k8s-family:
   a. Fetch the blob (file map) from the secrets backend.
   b. Create a Kubernetes Secret named `ark-creds-<sessionId>` in the
      compute's namespace, one `data` entry per file, `type: Opaque`,
      labeled `ark.dev/session-creds=true`.
   c. `mergeConfig` the compute row to set `credsSecretName` on it.
      K8sProvider.launch reads that field and mounts the Secret at
      `/root/.claude` (mode `0400`).
   d. Stash the Secret name + namespace on the session's config so
      teardown can find it.

At session stop / delete, teardown deletes the Secret. Missing Secrets
(already gone, or never created) are a no-op.

## Crash semantics

If the daemon crashes between "Secret created" and "session teardown
ran", a single `ark-creds-<sessionId>` Secret leaks in the target
namespace. Every Secret carries the label `ark.dev/session-creds=true`
so operators can sweep orphans with:

```bash
# Delete every per-session creds Secret older than 1 day in your ark namespace.
kubectl -n <ns> get secret -l ark.dev/session-creds=true -o json \
  | jq -r '.items[] | select((.metadata.creationTimestamp | fromdate) < (now - 86400)) | .metadata.name' \
  | xargs -n1 kubectl -n <ns> delete secret
```

## Leak recovery

Three layers protect against the "daemon crashed before teardown" leak,
ordered from tightest to broadest window:

1. **k8s owner-ref GC (inline, post-launch).** Immediately after
   `K8sProvider.launch` creates the session Pod, dispatch patches the
   per-session Secret's `metadata.ownerReferences` to point at the Pod
   (`apiVersion: v1`, `kind: Pod`, `blockOwnerDeletion: true`,
   `controller: false`). From that moment on, the cluster's native
   garbage collector deletes the Secret whenever the Pod is removed --
   including when Ark is offline. This handles the "crashed after Pod
   created" window. The patch is best-effort: a 404 on the Secret or
   Pod is logged at warn and the launch continues (covers the race
   where the Pod was already deleted mid-flight).

2. **Boot-time reconciler.** On every daemon boot, after migrations +
   resource seeding, `reconcileOrphanedCredsSecrets` walks every
   configured cluster, lists Secrets labeled
   `ark.dev/session-creds=true`, and:
   - skips Secrets that already have `ownerReferences` (k8s GC owns
     them),
   - deletes Secrets whose backing session is missing or in a terminal
     state (`completed` / `failed` / `archived` / `stopped`),
   - keeps Secrets that belong to an active session (a late-arriving
     `setSecretOwnerToPod` is expected to attach the owner-ref) and
     logs one warning per kept Secret.

   Runs as a non-blocking tail-task off `AppContext.boot()` -- a slow
   or unreachable cluster never blocks the daemon from serving the
   first request. Summary line is emitted at info-level:
   `creds-reconciler: pass complete { deleted, kept, errors, clusters }`.
   This handles the "crashed between Secret create and Pod create"
   window, which the owner-ref path can't reach.

3. **Periodic janitor (pending).** A future arkd loop will run the same
   sweep at a configurable cadence so long-lived daemons also converge
   even without a boot. Tracked in the GH issue for
   `ark.dev/session-creds` janitor work. Until it ships, a daemon that
   never restarts will accumulate orphans from the active-session
   warn-and-keep branch -- operators can run the `kubectl` one-liner
   above as a manual sweep.

## Blob storage layout

The blob lives in whichever secrets backend the tenant is configured
with:

| Backend | Location |
| --- | --- |
| File | `<arkDir>/secrets/<tenant>/<blobName>/<file>`, mode 0600, dir 0700 |
| AWS SSM | `/ark/<tenant>/blobs/<blobName>/<file>` as a SecureString (base64 wire format) |

`ark secrets blob list` / `upload` / `download` / `delete` talk to this
namespace. It's separate from the string-secret namespace (same tenant
can have both `ANTHROPIC_API_KEY` and `claude-subscription`).

## Running the live k8s "from blob" end-to-end test

The unit tests use a stubbed k8s API. For a real end-to-end assertion
against a live cluster:

```bash
export E2E_K8S_CLUSTER=1
export E2E_K8S_WITH_CLAUDE=1
export E2E_K8S_FROM_BLOB=1
export KUBECONFIG=$HOME/.kube/config

# Upload your claude credentials as a blob, bind, dispatch a session:
ark secrets blob upload claude-subscription ~/.claude
ark tenant auth set default --subscription-blob claude-subscription

# Then run the existing k8s-with-claude e2e test; it now exercises the
# dispatch-materialized Secret path instead of the test-harness shortcut.
bun test packages/core/services/__tests__/k8s-e2e-flow.test.ts
```

Cleanup (once you're done):

```bash
ark tenant auth clear default
ark secrets blob delete claude-subscription
```
