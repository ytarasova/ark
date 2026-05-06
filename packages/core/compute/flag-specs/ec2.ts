/**
 * EC2 provider flag spec.
 *
 * Owns `--size`, `--arch`, `--aws-region`, `--aws-profile`,
 * `--aws-subnet-id`, `--aws-tag <k=v>` (repeatable).
 *
 * AWS-specific flags carry the `--aws-` prefix to (a) avoid collision with
 * the root `ark -p, --profile <name>` ark-profile selector and (b) make it
 * obvious at a glance that they're cloud-provider-specific. `--size` and
 * `--arch` stay un-prefixed because they're generic VM concepts other
 * providers (firecracker, k8s) may share later.
 *
 * The summary looks up the pretty size label from `INSTANCE_SIZES` when
 * available, falling back to the raw flag value.
 */

import type { ProviderFlagSpec } from "../flag-spec.js";
import { INSTANCE_SIZES } from "../ec2/provision.js";

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
    { flag: "--aws-region <region>", description: "AWS region", default: "us-east-1" },
    { flag: "--aws-profile <profile>", description: "AWS profile" },
    { flag: "--aws-subnet-id <id>", description: "AWS subnet ID" },
    { flag: "--aws-tag <key=value>", description: "AWS tag (repeatable)" },
  ],
  configFromFlags(opts) {
    const tags = parseTags(opts.awsTag);
    return {
      size: opts.size,
      arch: opts.arch,
      region: opts.awsRegion,
      ...(opts.awsProfile ? { aws_profile: opts.awsProfile } : {}),
      ...(opts.awsSubnetId ? { subnet_id: opts.awsSubnetId } : {}),
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
    lines.push(`  Region:   ${(opts.awsRegion as string | undefined) ?? (config.region as string | undefined) ?? ""}`);
    return lines;
  },
};
