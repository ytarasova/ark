/**
 * Test-only helper -- map a compute row's two-axis (compute_kind,
 * isolation_kind) pair back onto the legacy provider name. Mirrors the
 * (now-deleted) `pairToProvider` from `compute/adapters/`. Used by
 * pre-Task-5 tests that asserted on the legacy string; new tests should
 * assert on `compute_kind` + `isolation_kind` directly.
 */

import type { Compute } from "../../../types/index.js";

export function legacyProviderLabel(c: Pick<Compute, "compute_kind" | "isolation_kind">): string {
  const ck = c.compute_kind;
  const ik = c.isolation_kind;
  if (ck === "local") {
    if (ik === "direct") return "local";
    if (ik === "docker") return "docker";
    if (ik === "devcontainer") return "devcontainer";
    if (ik === "firecracker-in-container") return "firecracker";
  }
  if (ck === "ec2") {
    if (ik === "direct") return "ec2";
    if (ik === "docker") return "ec2-docker";
    if (ik === "devcontainer") return "ec2-devcontainer";
    if (ik === "firecracker-in-container") return "ec2-firecracker";
  }
  if (ck === "firecracker") return "firecracker";
  if (ck === "k8s") return "k8s";
  if (ck === "k8s-kata") return "k8s-kata";
  return ck;
}
