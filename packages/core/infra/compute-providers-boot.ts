/**
 * ComputeProvidersBoot -- registers `Compute` + `Isolation` kinds on the
 * AppContext during startup.
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
      // Compute / Isolation registrations for Kubernetes
      try {
        await import("@kubernetes/client-node");
        const { K8sCompute } = await import("../compute/k8s.js");
        const { KataCompute } = await import("../compute/k8s-kata.js");
        this.app.registerCompute(new K8sCompute(this.app));
        this.app.registerCompute(new KataCompute(this.app));
      } catch {
        logDebug("general", "@kubernetes/client-node not installed");
      }

      // Compute + Isolation registry (additive, local providers always on)
      const { LocalCompute } = await import("../compute/local.js");
      const { EC2Compute } = await import("../compute/ec2/compute.js");
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
      const { registerFirecrackerIfAvailable } = await import("../compute/firecracker/compute.js");
      registerFirecrackerIfAvailable(this.app);
    });
  }

  stop(): void {
    // no-op: provider registrations are idempotent map entries; nothing to tear down
  }
}
