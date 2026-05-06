/**
 * Typed config surface for `DockerIsolation`.
 *
 * Today's `LocalDockerProvider` reads the same keys off a loose
 * `Record<string, unknown>` bag on `compute.config`. Pulling them into a
 * named type keeps the Isolation call sites explicit and lets sibling
 * isolations (`DockerComposeIsolation`, `DevcontainerIsolation`) diverge
 * cleanly.
 */

import type { BootstrapOpts } from "./docker-helpers.js";

export interface DockerIsolationConfig {
  /** Container image. Default `ubuntu:22.04` (see helpers `DEFAULT_IMAGE`). */
  image?: string;
  /** Extra `-v host:container[:mode]` volume specs passed through to docker create. */
  volumes?: string[];
  /** Bootstrap knobs (install git / bun / tmux / claude, or skip). */
  bootstrap?: BootstrapOpts;
  /** Extra env vars the isolation should export before invoking the launcher. */
  env?: Record<string, string>;
}
