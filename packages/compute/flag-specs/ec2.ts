/**
 * EC2 provider flag spec.
 *
 * Owns `--size`, `--arch`, `--region`, `--profile`, `--subnet-id`,
 * `--tag <k=v>` (repeatable). The summary looks up the pretty size label
 * from `INSTANCE_SIZES` when available, falling back to the raw flag value.
 */

import type { ProviderFlagSpec } from "../flag-spec.js";
import { INSTANCE_SIZES } from "../providers/ec2/provision.js";

function parseTags(raw: unknown): Record<string, string> {
  if (!Array.isArray(raw)) return {};
  const tags: Record<string, string> = {};
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "string") continue;
    const [k, ...rest] = entry.split("=");
    if (k && rest.length) tags[k] = rest.join("=");
  }
  return tags;
}

export const ec2FlagSpec: ProviderFlagSpec = {
  name: "ec2",
  options: [
    {
      flag: "--size <size>",
      description:
        "Instance size: xs (2vCPU/8GB), s (4/16), m (8/32), l (16/64), xl (32/128), xxl (48/192), xxxl (64/256)",
      default: "m",
    },
    { flag: "--arch <arch>", description: "Architecture: x64, arm", default: "x64" },
    { flag: "--region <region>", description: "Region", default: "us-east-1" },
    { flag: "--profile <profile>", description: "AWS profile" },
    { flag: "--subnet-id <id>", description: "Subnet ID" },
    { flag: "--tag <key=value>", description: "Tag (repeatable)" },
  ],
  configFromFlags(opts) {
    const tags = parseTags(opts.tag);
    return {
      size: opts.size,
      arch: opts.arch,
      region: opts.region,
      ...(opts.profile ? { aws_profile: opts.profile } : {}),
      ...(opts.subnetId ? { subnet_id: opts.subnetId } : {}),
      ...(Object.keys(tags).length ? { tags } : {}),
    };
  },
  displaySummary(config, opts) {
    const lines: string[] = [];
    const size = (opts.size as string | undefined) ?? (config.size as string | undefined);
    let sizeLabel = size ?? "";
    if (size) {
      const tier = INSTANCE_SIZES[size];
      if (tier) sizeLabel = tier.label;
    }
    lines.push(`  Size:     ${sizeLabel}`);
    lines.push(`  Arch:     ${(opts.arch as string | undefined) ?? (config.arch as string | undefined) ?? ""}`);
    lines.push(`  Region:   ${(opts.region as string | undefined) ?? (config.region as string | undefined) ?? ""}`);
    return lines;
  },
};
