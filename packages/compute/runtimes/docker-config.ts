/**
 * Typed config surface for `DockerRuntime`.
 *
 * Today's `LocalDockerProvider` reads the same keys off a loose
 * `Record<string, unknown>` bag on `compute.config`. Pulling them into a
 * named type keeps the Runtime call sites explicit and lets future Wave 2
 * work (`ComposeRuntime`, `DevcontainerRuntime`) diverge cleanly.
 */

import type { BootstrapOpts } from "../providers/docker/helpers.js";

export interface DockerRuntimeConfig {
  /** Container image. Default `ubuntu:22.04` (see helpers `DEFAULT_IMAGE`). */
  image?: string;
  /** Extra `-v host:container[:mode]` volume specs passed through to docker create. */
  volumes?: string[];
  /** Bootstrap knobs (install git / bun / tmux / claude, or skip). */
  bootstrap?: BootstrapOpts;
  /** Extra env vars the runtime should export before invoking the launcher. */
  env?: Record<string, string>;
}
