/**
 * Local provider flag spec.
 *
 * Local compute auto-provisions on the host that runs ark and exposes no
 * CLI-facing configuration. The spec is included in the registry so the
 * CLI can uniformly dispatch `getFlagSpec(provider)` without a special case.
 */

import type { ProviderFlagSpec } from "../flag-spec.js";

export const localFlagSpec: ProviderFlagSpec = {
  name: "local",
  options: [],
  configFromFlags() {
    return {};
  },
  displaySummary() {
    return [];
  },
};
