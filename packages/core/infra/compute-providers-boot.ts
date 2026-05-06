/**
 * ComputeProvidersBoot -- registers legacy `ComputeProvider`s + new
 * `Compute` / `Isolation` kinds on the AppContext during startup.
 *
 * Extracted from `AppContext._registerComputeProviders`. Split into a
 * service so it can run as part of the Lifecycle start phase and isn't
 * tied to private helpers on AppContext.
 */
import type { AppContext } from "../app.js";
import { safeAsync } from "../safe.js";
import { logDebug } from "../observability/structured-log.js";

export class ComputeProvidersBoot {
  constructor(private readonly app: AppContext) {}

  async start(): Promise<void> {
    await safeAsync("boot: load compute providers", async () => {
      const compute = await import("../compute/index.js");
      compute.setComputeApp(this.app);
      const providers = [
        new compute.LocalWorktreeProvider(this.app),
        new compute.LocalDockerProvider(this.app),
        new compute.LocalDevcontainerProvider(this.app),
        new compute.LocalFirecrackerProvider(this.app),
        new compute.RemoteWorktreeProvider(this.app),
        new compute.RemoteDockerProvider(this.app),
        new compute.RemoteDevcontainerProvider(this.app),
        new compute.RemoteFirecrackerProvider(this.app),
      ];
      for (const p of providers) {
        this.app.registerProvider(p);
      }

      // Optional: Kubernetes providers (gated on SDK install)
      try {
        const { K8sProvider, KataProvider } = await import("../compute/providers/k8s.js");
        const k8s = new K8sProvider(this.app);
        this.app.registerProvider(k8s);
        const kata = new KataProvider(this.app);
        this.app.registerProvider(kata);
      } catch {
        logDebug("general", "@kubernetes/client-node not installed");
      }

      // Compute / Isolation registrations for Kubernetes
      try {
        await import("@kubernetes/client-node");
        const { K8sCompute } = await import("../compute/core/k8s.js");
        const { KataCompute } = await import("../compute/core/k8s-kata.js");
        this.app.registerCompute(new K8sCompute(this.app));
        this.app.registerCompute(new KataCompute(this.app));
      } catch {
        logDebug("general", "@kubernetes/client-node not installed");
      }

      // Compute + Isolation registry (additive, local providers always on)
      const { LocalCompute } = await import("../compute/core/local.js");
      const { EC2Compute } = await import("../compute/core/ec2.js");
      const { DirectIsolation } = await import("../compute/isolation/direct.js");
      const { DockerIsolation } = await import("../compute/isolation/docker.js");
      const { DevcontainerIsolation } = await import("../compute/isolation/devcontainer.js");
      const { DockerComposeIsolation } = await import("../compute/isolation/docker-compose.js");
      this.app.registerCompute(new LocalCompute(this.app));
      this.app.registerCompute(new EC2Compute(this.app));
      this.app.registerIsolation(new DirectIsolation(this.app));
      this.app.registerIsolation(new DockerIsolation(this.app));
      this.app.registerIsolation(new DevcontainerIsolation(this.app));
      this.app.registerIsolation(new DockerComposeIsolation(this.app));

      // FirecrackerCompute (gated on /dev/kvm availability)
      const { registerFirecrackerIfAvailable } = await import("../compute/core/firecracker/compute.js");
      registerFirecrackerIfAvailable(this.app);
    });
  }

  stop(): void {
    // no-op: provider registrations are idempotent map entries; nothing to tear down
  }
}
