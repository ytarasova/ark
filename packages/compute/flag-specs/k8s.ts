/**
 * Kubernetes provider flag spec (covers both `k8s` and `k8s-kata`).
 *
 * Owns `--namespace`, `--image`, `--kubeconfig`, `--runtime-class`.
 * The `k8s-kata` alias maps to the same spec via `flag-specs/index.ts`.
 */

import type { ProviderFlagSpec } from "../flag-spec.js";

const DEFAULT_NAMESPACE = "ark";
const DEFAULT_IMAGE = "ubuntu:22.04";

export const k8sFlagSpec: ProviderFlagSpec = {
  name: "k8s",
  options: [
    { flag: "--namespace <ns>", description: "K8s namespace (k8s/k8s-kata provider)", default: DEFAULT_NAMESPACE },
    { flag: "--image <image>", description: "Docker image (default: ubuntu:22.04)" },
    { flag: "--kubeconfig <path>", description: "Path to kubeconfig (k8s/k8s-kata provider)" },
    { flag: "--runtime-class <class>", description: "K8s runtime class (kata-fc for Firecracker)" },
  ],
  configFromFlags(opts) {
    return {
      ...(opts.namespace ? { namespace: opts.namespace } : {}),
      ...(opts.image ? { image: opts.image } : {}),
      ...(opts.kubeconfig ? { kubeconfig: opts.kubeconfig } : {}),
      ...(opts.runtimeClass ? { runtimeClassName: opts.runtimeClass } : {}),
    };
  },
  displaySummary(config) {
    const lines: string[] = [];
    lines.push(`  Namespace:  ${(config.namespace as string) ?? DEFAULT_NAMESPACE}`);
    lines.push(`  Image:      ${(config.image as string) ?? DEFAULT_IMAGE}`);
    if (config.runtimeClassName) lines.push(`  Runtime:    ${config.runtimeClassName}`);
    if (config.kubeconfig) lines.push(`  Kubeconfig: ${config.kubeconfig}`);
    return lines;
  },
};
