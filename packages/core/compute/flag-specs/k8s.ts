/**
 * Kubernetes provider flag spec (covers both `k8s` and `k8s-kata`).
 *
 * Owns `--context`, `--namespace`, `--image`, `--kubeconfig`,
 * `--service-account`, `--runtime-class`, `--cpu`, `--memory`.
 * The `k8s-kata` alias maps to the same spec via `flag-specs/index.ts`.
 *
 * `--context` and `--namespace` and `--image` have no silent defaults --
 * a misconfigured compute target should fail at create time, not provision
 * pods into the wrong cluster or namespace.
 */

import type { ProviderFlagSpec } from "../flag-spec.js";

export const k8sFlagSpec: ProviderFlagSpec = {
  name: "k8s",
  options: [
    { flag: "--context <name>", description: "Kubeconfig context (cluster) -- required" },
    { flag: "--namespace <ns>", description: "K8s namespace -- required" },
    { flag: "--image <image>", description: "Container image for agent pods -- required" },
    { flag: "--kubeconfig <path>", description: "Path to kubeconfig (default: in-cluster or ~/.kube/config)" },
    { flag: "--service-account <sa>", description: "Pod service account name (for IRSA, etc.)" },
    { flag: "--runtime-class <class>", description: "K8s runtime class (e.g. kata-fc for Firecracker)" },
    { flag: "--cpu <amt>", description: "CPU request/limit (e.g. 2 or 500m)" },
    { flag: "--memory <amt>", description: "Memory request/limit (e.g. 4Gi)" },
  ],
  configFromFlags(opts) {
    const cfg: Record<string, unknown> = {};
    if (opts.context) cfg.context = opts.context;
    if (opts.namespace) cfg.namespace = opts.namespace;
    if (opts.image) cfg.image = opts.image;
    if (opts.kubeconfig) cfg.kubeconfig = opts.kubeconfig;
    if (opts.serviceAccount) cfg.serviceAccount = opts.serviceAccount;
    if (opts.runtimeClass) cfg.runtimeClassName = opts.runtimeClass;
    if (opts.cpu || opts.memory) {
      cfg.resources = {
        ...(opts.cpu ? { cpu: String(opts.cpu) } : {}),
        ...(opts.memory ? { memory: String(opts.memory) } : {}),
      };
    }
    return cfg;
  },
  displaySummary(config) {
    const lines: string[] = [];
    if (config.context) lines.push(`  Context:    ${config.context}`);
    if (config.namespace) lines.push(`  Namespace:  ${config.namespace}`);
    if (config.image) lines.push(`  Image:      ${config.image}`);
    if (config.serviceAccount) lines.push(`  ServiceAcc: ${config.serviceAccount}`);
    if (config.runtimeClassName) lines.push(`  Runtime:    ${config.runtimeClassName}`);
    if (config.kubeconfig) lines.push(`  Kubeconfig: ${config.kubeconfig}`);
    const res = config.resources as { cpu?: string; memory?: string } | undefined;
    if (res?.cpu || res?.memory) lines.push(`  Resources:  cpu=${res?.cpu ?? "-"} mem=${res?.memory ?? "-"}`);
    return lines;
  },
};
