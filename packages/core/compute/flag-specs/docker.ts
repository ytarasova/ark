/**
 * Docker provider flag spec.
 *
 * Owns `--image`, `--devcontainer`, `--volume <mount>` (repeatable).
 * `configFromFlags` mirrors the previous hard-coded block from
 * `packages/cli/commands/compute.ts`.
 */

import type { ProviderFlagSpec } from "../flag-spec.js";

const DEFAULT_IMAGE = "ubuntu:22.04";

export const dockerFlagSpec: ProviderFlagSpec = {
  name: "docker",
  options: [
    { flag: "--image <image>", description: "Docker image (default: ubuntu:22.04)" },
    { flag: "--devcontainer", description: "Use devcontainer.json from project" },
    { flag: "--volume <mount>", description: "Extra volume mount (repeatable)" },
  ],
  configFromFlags(opts) {
    const image = typeof opts.image === "string" && opts.image ? opts.image : DEFAULT_IMAGE;
    const volumes = Array.isArray(opts.volume) ? (opts.volume as string[]) : [];
    return {
      image,
      ...(opts.devcontainer ? { devcontainer: true } : {}),
      ...(volumes.length ? { volumes } : {}),
    };
  },
  displaySummary(config) {
    const lines: string[] = [];
    lines.push(`  Image:    ${(config.image as string) ?? DEFAULT_IMAGE}`);
    if (config.devcontainer) lines.push(`  Devcontainer: yes`);
    const volumes = config.volumes as string[] | undefined;
    if (volumes?.length) {
      lines.push(`  Volumes:  ${volumes.join(", ")}`);
    }
    return lines;
  },
};
