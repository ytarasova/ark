# Running the k8s E2E tests locally

`packages/core/services/__tests__/k8s-e2e-flow.test.ts` contains two live
Kubernetes E2E suites. Both are skipped by default so CI can never touch a
real cluster. You opt in by setting env vars on your workstation.

| Suite               | Gate(s)                                           | What it exercises                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action-only noop    | `E2E_K8S_CLUSTER`                                 | `e2e-noop` flow (single `close_ticket` action). Does **not** create a session pod -- the action stage resolves in-process. Safe to run with a vanilla cluster context and no creds.                                                    |
| Session pod + agent | `E2E_K8S_CLUSTER` **and** `E2E_K8S_WITH_CLAUDE=1` | `e2e-noop-agent` flow (single agent stage). Creates a session pod via `K8sProvider.launch`, mounts a Secret with your local Claude subscription into the pod, runs a trivial "write hello world" agent, then asserts zero leaked pods. |

CI must only ever have `E2E_K8S_CLUSTER` unset -- the second gate is
intentionally not a safe default because the test requires a live Claude
subscription on the machine running it.

## Prerequisites

1. A reachable Kubernetes cluster you are willing to create Pods + Secrets
   in. EKS, kind, minikube, k3d all work.
2. A kubeconfig context pinned to that cluster. `~/.kube/config` with a
   named context is fine.
3. A Kubernetes namespace (the default is `ark`). Create it up front or let
   the provider create it on first `provision()` call.
4. A container image reachable from the cluster that ships the Claude Code
   CLI + Bun. The default the test uses is
   `ghcr.io/anthropics/claude-code:latest`. Override via
   `E2E_K8S_IMAGE_WITH_CLAUDE` if you want a slimmer pinned image.
5. For the agent suite: your local `~/.claude/` directory with a working
   subscription (`/login` completed at least once). The test reads files at
   the top level of that directory and base64-packs them into a Secret.
   Subdirectories are deliberately skipped -- keep it flat.

## Environment variables

| Variable                    | Required         | Default                                 | Purpose                                                                         |
| --------------------------- | ---------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| `E2E_K8S_CLUSTER`           | yes              | --                                      | Kubeconfig context name. Both suites skip unless this is set.                   |
| `E2E_K8S_NAMESPACE`         | no               | `ark`                                   | Namespace for Pods + Secrets.                                                   |
| `E2E_K8S_IMAGE`             | no               | `alpine:3.19`                           | Image used by the action-only suite + the clone's instance pod. Keep slim.      |
| `E2E_K8S_IMAGE_WITH_CLAUDE` | no               | `ghcr.io/anthropics/claude-code:latest` | Image used by the session pod in the agent suite. Must bundle `claude` + `bun`. |
| `E2E_K8S_WITH_CLAUDE`       | agent suite only | --                                      | Set to `1` to opt into the agent + creds-mount suite.                           |
| `CLAUDE_SUBSCRIPTION_PATH`  | no               | `~/.claude`                             | Directory whose files get packed into the creds Secret.                         |

## Running the tests

```bash
# Action-only -- no creds touched.
E2E_K8S_CLUSTER=my-kube-ctx \
E2E_K8S_NAMESPACE=ark \
  bun test packages/core/services/__tests__/k8s-e2e-flow.test.ts

# Session pod + agent -- mounts your local claude subscription.
E2E_K8S_CLUSTER=my-kube-ctx \
E2E_K8S_NAMESPACE=ark \
E2E_K8S_WITH_CLAUDE=1 \
E2E_K8S_IMAGE_WITH_CLAUDE=ghcr.io/anthropics/claude-code:latest \
CLAUDE_SUBSCRIPTION_PATH="$HOME/.claude" \
  bun test packages/core/services/__tests__/k8s-e2e-flow.test.ts
```

## What happens under the hood (agent suite)

1. `beforeAll` creates a `k8s` template compute row, provisions the
   namespace, then reads every file at the top level of
   `CLAUDE_SUBSCRIPTION_PATH` and creates a `Secret` whose data keys are the
   filenames (base64-encoded contents). The Secret name is
   `ark-claude-creds-<ts>` so repeated runs don't collide.
2. The test clones the template into a concrete compute row, injects
   `credsSecretName: <secret>` into the clone's config, and calls
   `provider.start()` to bring up the long-lived instance pod.
3. `startSession` + `dispatch` kick off the `e2e-noop-agent` flow. The
   dispatcher calls `K8sProvider.launch`, which creates a pod named
   `ark-<sessionId>` with the Secret mounted read-only at `/root/.claude`.
4. The Claude runtime inside the pod auto-discovers `~/.claude`, sees the
   mounted subscription, runs three turns (write one file, then call
   `report` with `type=completed`).
5. Session hits `status=completed`, `killAgent` deletes the session pod,
   and the stage-advance GC path deletes the clone compute row.
6. `afterAll` deletes the Secret and template row. Best-effort -- the test
   also asserts zero leaked pods explicitly.

### Inspecting a run in flight

While the test is running you can watch the session pod directly:

```bash
kubectl --context "$E2E_K8S_CLUSTER" -n "$E2E_K8S_NAMESPACE" \
  get pods -l ark.dev/role!=instance -w

# Tail logs
kubectl --context "$E2E_K8S_CLUSTER" -n "$E2E_K8S_NAMESPACE" logs -f ark-<sessionId>

# Verify the creds mount
kubectl --context "$E2E_K8S_CLUSTER" -n "$E2E_K8S_NAMESPACE" \
  exec ark-<sessionId> -- ls -la /root/.claude
```

The mount should list every file you had at the top of
`CLAUDE_SUBSCRIPTION_PATH`, owned by root, mode `0400`. If the ls is empty,
the Secret didn't get created or the pod raced the Secret -- rerun with a
kubectl session open against the Secret to rule out the timing.

### Expected success output

```
k8s e2e flow (live cluster)
  provisions the k8s template into a live instance pod  [ok]
  starts a session on e2e-noop and reaches status=completed  [ok]
  logs action_executed + session_completed events  [ok]
  GCs the clone compute row after the session completes  [ok]

k8s e2e flow -- session pod + agent stage (live cluster + live claude)
  provisions the clone + wires the creds Secret into the config  [ok]
  runs the agent stage to completed inside the session pod  [ok]
  leaks zero pods after the session completes  [ok]
  GCs the clone compute row after the session completes  [ok]

 8 pass, 0 fail
```

Total runtime on a warm cluster (image already pulled): ~60--90 s. Cold
image pulls on the worker node can push that to several minutes; bump the
90 s timeout in the agent case if you're regularly cold.

## Notes on provider compatibility

- `K8sProvider` (vanilla pods) and `KataProvider` (Kata Containers /
  Firecracker) share the same pod body construction, so the creds mount
  shape applies to both. Kata runtimeClass is orthogonal.
- Worker nodes that refuse the `Secret` volume plugin (e.g. highly locked
  down PSA profiles) will block the agent suite. The action-only suite is
  unaffected because it never exercises `launch`.
- EKS-backed clusters work. The Secret mount uses defaultMode `0400`, which
  is compatible with read-only root filesystems.
- The session pod does not run as a non-root user by default. If your
  cluster enforces `runAsNonRoot`, set `credsMountPath` to a directory the
  runtime user can read and update the image accordingly -- the provider
  does not yet template `securityContext`.

## Troubleshooting

- **"context X not found in kubeconfig"**: `E2E_K8S_CLUSTER` must be the
  kubeconfig context name, not the cluster ARN. `kubectl config
get-contexts` lists valid values.
- **Session stuck at `status=running` forever**: the agent likely never
  called `report(completed)`. Check the pod logs -- the most common cause
  is the mounted Secret lacking a valid subscription token, in which case
  Claude will ask for `/login` and the agent loop will time out. Regenerate
  `~/.claude/` locally and rerun.
- **Creds Secret sticks around after a failed run**: the test's `afterAll`
  normally deletes it, but a crashed `beforeAll` can leak one. Clean up
  with `kubectl delete secret -l ark.dev/e2e=1 -n "$E2E_K8S_NAMESPACE"`.
