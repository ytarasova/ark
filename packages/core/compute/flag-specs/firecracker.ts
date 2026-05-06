/**
 * Firecracker provider flag spec.
 *
 * The local Firecracker compute (see `packages/compute/firecracker/compute.ts`)
 * derives its kernel, rootfs, and networking from host state; no CLI-exposed
 * knobs today. Kept as a stub so the CLI can uniformly resolve a spec for
 * every known provider, and so future flags land in one obvious place.
 */

import type { ProviderFlagSpec } from "../flag-spec.js";

export const firecrackerFlagSpec: ProviderFlagSpec = {
  name: "firecracker",
  options: [],
  configFromFlags() {
    return {};
  },
  displaySummary() {
    return [];
  },
};
