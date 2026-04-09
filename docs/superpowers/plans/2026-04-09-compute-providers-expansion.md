# Compute Providers Expansion: E2B + K8s

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add E2B (managed Firecracker VMs) and Kubernetes (vanilla + Kata/Firecracker) as compute providers. All three use the existing ComputeProvider interface + awilix DI.

**Architecture:** Each provider is one file implementing ComputeProvider. Registered during boot via `setApp()`. E2B uses their SDK. K8s uses @kubernetes/client-node. K8s+Kata uses the same K8s client with `runtimeClassName: kata-fc`.

**Tech Stack:** e2b SDK, @kubernetes/client-node, TypeScript, Bun

---

## Current Provider Landscape

| Provider | File | Transport | Isolation | Status |
|----------|------|-----------|-----------|--------|
| Local (tmux) | `local/index.ts` | Direct | Process | Done |
| Docker | `docker/index.ts` | Docker CLI | Container | Done |
| DevContainer | `local-arkd.ts` | ArkD HTTP | Container | Done |
| Firecracker (local) | `local-arkd.ts` | ArkD HTTP | MicroVM | Done |
| EC2 + ArkD | `remote-arkd.ts` | ArkD HTTP | Process/Container/VM | Done |
| **E2B** | `e2b.ts` | E2B SDK | MicroVM (managed) | New |
| **K8s** | `k8s.ts` | K8s API | Pod | New |
| **K8s + Kata** | `k8s.ts` | K8s API | MicroVM (Kata) | New |

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/compute/providers/e2b.ts` | Create | E2B managed sandbox provider |
| `packages/compute/providers/k8s.ts` | Create | Kubernetes provider (vanilla + Kata) |
| `packages/compute/types.ts` | Modify | Add E2B/K8s config types |
| `packages/compute/index.ts` | Modify | Export new providers |
| `packages/core/app.ts` | Modify | Register new providers in boot |
| `packages/compute/__tests__/e2b.test.ts` | Create | E2B provider tests |
| `packages/compute/__tests__/k8s.test.ts` | Create | K8s provider tests |

---

### Task 1: E2B Provider

**Install:** `bun add e2b`

**Create:** `packages/compute/providers/e2b.ts`

```ts
import { Sandbox } from "e2b";
import type { AppContext } from "../../core/app.js";
import type {
  ComputeProvider, Compute, Session, ProvisionOpts, LaunchOpts,
  IsolationMode, ComputeSnapshot,
} from "../types.js";

interface E2BConfig {
  provider: "e2b";
  template?: string;      // E2B sandbox template (default: "base")
  apiKey?: string;         // E2B API key (default: E2B_API_KEY env)
  timeout?: number;        // Sandbox timeout in seconds (default: 3600)
  [key: string]: unknown;
}

export class E2BProvider implements ComputeProvider {
  readonly name = "e2b";
  readonly isolationModes: IsolationMode[] = [
    { value: "sandbox", label: "E2B managed Firecracker sandbox" },
  ];
  readonly canDelete = true;
  readonly supportsWorktree = false;
  readonly initialStatus = "stopped";

  private app: AppContext | null = null;
  private sandboxes = new Map<string, Sandbox>();

  setApp(app: AppContext): void { this.app = app; }

  async provision(compute: Compute, _opts?: ProvisionOpts): Promise<void> {
    const cfg = compute.config as E2BConfig;
    this.app!.computes.update(compute.name, { status: "running" });
    // E2B sandboxes are created on-demand at launch time
    // Provision just validates the API key and template
    const apiKey = cfg.apiKey || process.env.E2B_API_KEY;
    if (!apiKey) throw new Error("E2B_API_KEY not set. Get one at https://e2b.dev");
  }

  async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
    const cfg = compute.config as E2BConfig;
    const apiKey = cfg.apiKey || process.env.E2B_API_KEY;
    const template = cfg.template || "base";
    const timeout = cfg.timeout || 3600;

    const sandbox = await Sandbox.create(template, {
      apiKey,
      timeoutMs: timeout * 1000,
      metadata: { sessionId: session.id, arkCompute: compute.name },
    });

    this.sandboxes.set(session.id, sandbox);

    // Write launcher script and execute
    await sandbox.filesystem.write("/tmp/ark-launch.sh", opts.launcherContent);
    const proc = await sandbox.process.start({
      cmd: "bash",
      args: ["/tmp/ark-launch.sh"],
      envs: opts.env || {},
    });

    // Store sandbox ID for reconnection
    this.app!.computes.mergeConfig(compute.name, {
      [`sandbox_${session.id}`]: sandbox.sandboxId,
    });

    return sandbox.sandboxId;
  }

  async killAgent(compute: Compute, session: Session): Promise<void> {
    const sandbox = this.sandboxes.get(session.id);
    if (sandbox) {
      await sandbox.close();
      this.sandboxes.delete(session.id);
    }
  }

  async cleanupSession(compute: Compute, session: Session): Promise<void> {
    await this.killAgent(compute, session);
  }

  async start(compute: Compute): Promise<void> {
    this.app!.computes.update(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    // Close all sandboxes for this compute
    for (const [sid, sandbox] of this.sandboxes) {
      await sandbox.close();
    }
    this.sandboxes.clear();
    this.app!.computes.update(compute.name, { status: "stopped" });
  }

  async destroy(compute: Compute): Promise<void> {
    await this.stop(compute);
    this.app!.computes.update(compute.name, { status: "destroyed" });
  }

  async getMetrics(compute: Compute): Promise<ComputeSnapshot> {
    return {
      status: compute.status,
      processes: [],
      docker: [],
      resources: { cpu: "N/A", memory: "N/A", disk: "N/A" },
    };
  }

  getAttachCommand(_compute: Compute, _session: Session): string[] {
    return ["echo", "E2B sandboxes do not support direct attach. Use ark session output."];
  }
}
```

---

### Task 2: Kubernetes Provider

**Install:** `bun add @kubernetes/client-node`

**Create:** `packages/compute/providers/k8s.ts`

```ts
import * as k8s from "@kubernetes/client-node";
import type { AppContext } from "../../core/app.js";
import type {
  ComputeProvider, Compute, Session, ProvisionOpts, LaunchOpts,
  IsolationMode, ComputeSnapshot,
} from "../types.js";

interface K8sConfig {
  provider: "k8s";
  namespace?: string;           // default: "ark"
  image?: string;               // default: "ubuntu:22.04"
  kubeconfig?: string;          // path to kubeconfig (default: in-cluster or ~/.kube/config)
  runtimeClassName?: string;    // "kata-fc" for Firecracker, null for vanilla
  serviceAccount?: string;
  resources?: {
    cpu?: string;               // e.g. "2"
    memory?: string;            // e.g. "4Gi"
  };
  [key: string]: unknown;
}

export class K8sProvider implements ComputeProvider {
  readonly name = "k8s";
  readonly isolationModes: IsolationMode[] = [
    { value: "pod", label: "Kubernetes Pod" },
    { value: "kata", label: "Kata Container (Firecracker microVM)" },
  ];
  readonly canDelete = true;
  readonly supportsWorktree = false;
  readonly initialStatus = "stopped";

  private app: AppContext | null = null;
  private kubeApi: k8s.CoreV1Api | null = null;

  setApp(app: AppContext): void { this.app = app; }

  private getApi(compute: Compute): k8s.CoreV1Api {
    if (this.kubeApi) return this.kubeApi;
    const kc = new k8s.KubeConfig();
    const cfg = compute.config as K8sConfig;
    if (cfg.kubeconfig) {
      kc.loadFromFile(cfg.kubeconfig);
    } else {
      kc.loadFromDefault(); // in-cluster or ~/.kube/config
    }
    this.kubeApi = kc.makeApiClient(k8s.CoreV1Api);
    return this.kubeApi;
  }

  private podName(session: Session): string {
    return `ark-${session.id}`;
  }

  async provision(compute: Compute): Promise<void> {
    // Validate K8s connectivity
    const api = this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";

    // Ensure namespace exists
    try {
      await api.readNamespace({ name: ns });
    } catch {
      await api.createNamespace({ body: { metadata: { name: ns } } });
    }

    this.app!.computes.update(compute.name, { status: "running" });
  }

  async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
    const api = this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";
    const name = this.podName(session);

    const pod: k8s.V1Pod = {
      metadata: {
        name,
        namespace: ns,
        labels: {
          "ark.dev/session": session.id,
          "ark.dev/compute": compute.name,
        },
      },
      spec: {
        restartPolicy: "Never",
        ...(cfg.runtimeClassName ? { runtimeClassName: cfg.runtimeClassName } : {}),
        ...(cfg.serviceAccount ? { serviceAccountName: cfg.serviceAccount } : {}),
        containers: [{
          name: "agent",
          image: cfg.image || "ubuntu:22.04",
          command: ["/bin/bash", "-c", opts.launcherContent],
          env: Object.entries(opts.env || {}).map(([name, value]) => ({ name, value })),
          resources: cfg.resources ? {
            requests: { cpu: cfg.resources.cpu, memory: cfg.resources.memory },
            limits: { cpu: cfg.resources.cpu, memory: cfg.resources.memory },
          } : undefined,
        }],
      },
    };

    await api.createNamespacedPod({ namespace: ns, body: pod });
    return name;
  }

  async killAgent(compute: Compute, session: Session): Promise<void> {
    const api = this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";
    try {
      await api.deleteNamespacedPod({ name: this.podName(session), namespace: ns });
    } catch { /* pod may already be gone */ }
  }

  async cleanupSession(compute: Compute, session: Session): Promise<void> {
    await this.killAgent(compute, session);
  }

  async start(compute: Compute): Promise<void> {
    this.app!.computes.update(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    // Delete all ark pods in namespace
    const api = this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";
    try {
      await api.deleteCollectionNamespacedPod({
        namespace: ns,
        labelSelector: `ark.dev/compute=${compute.name}`,
      });
    } catch {}
    this.app!.computes.update(compute.name, { status: "stopped" });
  }

  async destroy(compute: Compute): Promise<void> {
    await this.stop(compute);
    this.app!.computes.update(compute.name, { status: "destroyed" });
  }

  async getMetrics(compute: Compute): Promise<ComputeSnapshot> {
    const api = this.getApi(compute);
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";
    try {
      const { items } = await api.listNamespacedPod({ namespace: ns, labelSelector: `ark.dev/compute=${compute.name}` });
      return {
        status: compute.status,
        processes: (items || []).map(p => ({
          name: p.metadata?.name || "",
          pid: 0,
          cpu: "N/A",
          mem: "N/A",
          status: p.status?.phase || "Unknown",
        })),
        docker: [],
        resources: { cpu: "N/A", memory: "N/A", disk: "N/A" },
      };
    } catch {
      return { status: compute.status, processes: [], docker: [], resources: { cpu: "N/A", memory: "N/A", disk: "N/A" } };
    }
  }

  getAttachCommand(compute: Compute, session: Session): string[] {
    const cfg = compute.config as K8sConfig;
    const ns = cfg.namespace || "ark";
    return ["kubectl", "exec", "-it", "-n", ns, this.podName(session), "--", "/bin/bash"];
  }
}

/**
 * K8s with Kata Containers (Firecracker microVM isolation).
 * Same as K8sProvider but defaults runtimeClassName to "kata-fc".
 */
export class KataProvider extends K8sProvider {
  readonly name = "k8s-kata";
  readonly isolationModes: IsolationMode[] = [
    { value: "kata", label: "Kata Container (Firecracker microVM on K8s)" },
  ];
}
```

---

### Task 3: Register providers in boot

**Modify:** `packages/compute/index.ts` -- export E2BProvider, K8sProvider, KataProvider

**Modify:** `packages/core/app.ts` -- register in boot:

```ts
// Conditional: only register if SDK is available
try {
  const { E2BProvider } = await import("../compute/providers/e2b.js");
  const e2b = new E2BProvider();
  e2b.setApp(this);
  this.registerProvider(e2b);
} catch {} // e2b SDK not installed

try {
  const { K8sProvider, KataProvider } = await import("../compute/providers/k8s.js");
  const k8s = new K8sProvider();
  k8s.setApp(this);
  this.registerProvider(k8s);
  const kata = new KataProvider();
  kata.setApp(this);
  this.registerProvider(kata);
} catch {} // @kubernetes/client-node not installed
```

---

### Task 4: CLI support

**Modify:** `packages/cli/commands/compute.ts`

Add E2B and K8s to the `--provider` option choices:

```ts
.option("--provider <type>", "Provider: local, docker, e2b, k8s, k8s-kata", "local")
```

Add E2B-specific options:
```ts
.option("--template <template>", "E2B sandbox template (e2b provider)")
```

Add K8s-specific options:
```ts
.option("--namespace <ns>", "K8s namespace (k8s provider)", "ark")
.option("--image <image>", "Container image (k8s provider)", "ubuntu:22.04")
.option("--kubeconfig <path>", "Path to kubeconfig (k8s provider)")
.option("--runtime-class <class>", "K8s runtime class (kata-fc for Firecracker)")
```

---

### Task 5: Tests

**Create:** `packages/compute/__tests__/e2b.test.ts`
- Test provider instantiation
- Test setApp
- Test provision throws without API key
- Mock sandbox creation

**Create:** `packages/compute/__tests__/k8s.test.ts`
- Test provider instantiation
- Test setApp
- Test pod name generation
- Test KataProvider defaults runtimeClassName

---

### Task 6: Documentation

Update CLI reference and guide with:
```bash
# E2B managed sandboxes
ark compute create my-sandbox --provider e2b --template base
ark compute provision my-sandbox
ark session start --repo . --summary "Task" --compute my-sandbox --dispatch

# Kubernetes
ark compute create my-k8s --provider k8s --namespace ark --image node:20
ark compute provision my-k8s

# K8s with Firecracker (Kata Containers)
ark compute create my-kata --provider k8s-kata --namespace ark --runtime-class kata-fc
```

---

## Usage Examples

### E2B for fan-out test suite
```bash
ark compute create qa-sandbox --provider e2b --template node-20
ark session start --repo . --summary "Run test suite" --flow fan-out --compute qa-sandbox --dispatch
# Each child gets its own E2B sandbox (sub-second boot, full isolation)
```

### K8s for team CI
```bash
ark compute create ci-cluster --provider k8s --namespace ci --image ark-agent:latest
ark schedule add --cron "0 2 * * *" --summary "Nightly tests" --compute ci-cluster --flow fan-out
```

### K8s + Kata for security-sensitive workloads
```bash
ark compute create secure --provider k8s-kata --namespace secure --runtime-class kata-fc
ark session start --repo . --summary "Audit codebase" --compute secure --dispatch
```
