/**
 * ComputeProvidersBoot -- registers legacy `ComputeProvider`s + new
 * `Compute` / `Runtime` kinds on the AppContext during startup.
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
      const compute = await import("../../compute/index.js");
      compute.setComputeApp(this.app);
      const providers = [
        new compute.LocalProvider(),
        new compute.LocalDockerProvider(),
        new compute.LocalDevcontainerProvider(),
        new compute.LocalFirecrackerProvider(),
        new compute.RemoteDockerProvider(),
        new compute.RemoteDevcontainerProvider(),
        new compute.RemoteFirecrackerProvider(),
      ];
      for (const p of providers) {
        p.setApp?.(this.app);
        this.app.registerProvider(p);
      }

      // Optional: Kubernetes providers (gated on SDK install)
      try {
        const { K8sProvider, KataProvider } = await import("../../compute/providers/k8s.js");
        const k8s = new K8sProvider();
        k8s.setApp(this.app);
        this.app.registerProvider(k8s);
        const kata = new KataProvider();
        kata.setApp(this.app);
        this.app.registerProvider(kata);
      } catch {
        logDebug("general", "@kubernetes/client-node not installed");
      }

      // Compute / Runtime registrations for Kubernetes
      try {
        await import("@kubernetes/client-node");
        const { K8sCompute } = await import("../../compute/core/k8s.js");
        const { KataCompute } = await import("../../compute/core/k8s-kata.js");
        this.app.registerCompute(new K8sCompute());
        this.app.registerCompute(new KataCompute());
      } catch {
        logDebug("general", "@kubernetes/client-node not installed");
      }

      // Compute + Runtime registry (additive, local providers always on)
      const { LocalCompute } = await import("../../compute/core/local.js");
      const { EC2Compute } = await import("../../compute/core/ec2.js");
      const { DirectRuntime } = await import("../../compute/runtimes/direct.js");
      const { DockerRuntime } = await import("../../compute/runtimes/docker.js");
      const { DevcontainerRuntime } = await import("../../compute/runtimes/devcontainer.js");
      const { DockerComposeRuntime } = await import("../../compute/runtimes/docker-compose.js");
      this.app.registerCompute(new LocalCompute());
      this.app.registerCompute(new EC2Compute());
      this.app.registerRuntime(new DirectRuntime());
      this.app.registerRuntime(new DockerRuntime());
      this.app.registerRuntime(new DevcontainerRuntime());
      this.app.registerRuntime(new DockerComposeRuntime());

      // FirecrackerCompute (gated on /dev/kvm availability)
      const { registerFirecrackerIfAvailable } = await import("../../compute/core/firecracker/compute.js");
      registerFirecrackerIfAvailable(this.app);
    });
  }

  stop(): void {
    // no-op: provider registrations are idempotent map entries; nothing to tear down
  }
}
