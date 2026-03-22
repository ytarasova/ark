/**
 * Pulumi Automation API for managing EC2 infrastructure as stacks.
 *
 * Provides fully programmatic provisioning and teardown of EC2 instances
 * using Pulumi's inline program model with a local file-based backend.
 */

import * as path from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { LocalWorkspace } from "@pulumi/pulumi/automation/index.js";
import type {
  LocalWorkspaceOptions,
  InlineProgramArgs,
} from "@pulumi/pulumi/automation/index.js";
import { ConfigValue } from "@pulumi/pulumi/automation/index.js";

// ---------------------------------------------------------------------------
// Instance size tiers — maps size label to [x64_type, arm_type]
// ---------------------------------------------------------------------------

export interface SizeTier {
  types: [string, string];   // [x64, arm]
  vcpu: number;
  memGb: number;
  label: string;             // human-readable
}

export const INSTANCE_SIZES: Record<string, SizeTier> = {
  xs:   { types: ["m6i.large",    "m6g.large"],    vcpu: 2,  memGb: 8,   label: "Extra Small (2 vCPU, 8 GB)" },
  s:    { types: ["m6i.xlarge",   "m6g.xlarge"],   vcpu: 4,  memGb: 16,  label: "Small (4 vCPU, 16 GB)" },
  m:    { types: ["m6i.2xlarge",  "m6g.2xlarge"],  vcpu: 8,  memGb: 32,  label: "Medium (8 vCPU, 32 GB)" },
  l:    { types: ["m6i.4xlarge",  "m6g.4xlarge"],  vcpu: 16, memGb: 64,  label: "Large (16 vCPU, 64 GB)" },
  xl:   { types: ["m6i.8xlarge",  "m6g.8xlarge"],  vcpu: 32, memGb: 128, label: "X-Large (32 vCPU, 128 GB)" },
  xxl:  { types: ["m6i.12xlarge", "m6g.12xlarge"], vcpu: 48, memGb: 192, label: "2X-Large (48 vCPU, 192 GB)" },
  xxxl: { types: ["m6i.16xlarge", "m6g.16xlarge"], vcpu: 64, memGb: 256, label: "4X-Large (64 vCPU, 256 GB)" },
};

// AMI name patterns by architecture
const AMI_PATTERNS: Record<string, string> = {
  x64: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*",
  arm: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-arm64-server-*",
};

// VPN/office CIDRs allowed SSH access to ark computes
const VPN_CIDRS = [
  "10.10.0.0/23",     // Richmond Office VPN
  "10.226.100.0/24",  // Remote VPN
  "10.228.0.0/23",    // Labs VPN
  "10.98.5.0/24",     // Fortinet VPN
  "10.62.0.0/16",     // PPSL Zscaler VPN
  "172.16.1.0/24",    // Zscaler Tunnel (Skymark DR)
];

// ---------------------------------------------------------------------------
// resolveInstanceType
// ---------------------------------------------------------------------------

/**
 * Resolve a size label (xs/s/m/l/xl/xxl/xxxl) + arch (x64/arm) to an
 * EC2 instance type string.
 *
 * If `size` is not a known label, it is treated as a literal instance type.
 * If `size` is undefined/empty, returns `fallback` (default "m6i.2xlarge").
 */
export function resolveInstanceType(
  size?: string,
  arch: string = "x64",
  fallback: string = "m6i.2xlarge",
): string {
  if (!size) return fallback;
  if (size in INSTANCE_SIZES) {
    const tier = INSTANCE_SIZES[size];
    return arch === "arm" ? tier.types[1] : tier.types[0];
  }
  return size; // literal instance type passthrough
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisionResult {
  ip: string | null;
  instance_id: string;
  stack_name: string;
  sg_id?: string;
  key_name?: string;
}

export interface ProvisionStackOpts {
  size?: string;
  arch?: string;
  region?: string;
  subnetId?: string;
  securityGroupId?: string;
  userData?: string;
  tags?: Record<string, string>;
  keyName?: string;
  sshKeyPath?: string;
  awsProfile?: string;
  onOutput?: (msg: string) => void;
}

export interface DestroyStackOpts {
  region?: string;
  stackName?: string;
  awsProfile?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stackName(hostName: string): string {
  return `ark-compute-${hostName}`;
}

function workspaceOpts(region: string, awsProfile?: string): LocalWorkspaceOptions {
  const stateDir = path.join(homedir(), ".ark", "pulumi");
  mkdirSync(stateDir, { recursive: true });

  return {
    envVars: {
      PULUMI_CONFIG_PASSPHRASE: "",
      AWS_DEFAULT_REGION: region,
      ...(awsProfile ? { AWS_PROFILE: awsProfile } : {}),
    },
    projectSettings: {
      name: "ark-ec2",
      runtime: "nodejs",
      backend: { url: `file://${stateDir}` },
    },
  };
}

// ---------------------------------------------------------------------------
// Pulumi inline program builder
// ---------------------------------------------------------------------------

function makePulumiProgram(
  instanceType: string,
  hostName: string,
  opts: {
    arch: string;
    keyName?: string;
    subnetId?: string;
    securityGroupId?: string;
    userData?: string;
    tags?: Record<string, string>;
  },
) {
  return async function pulumiProgram() {
    const arch = opts.arch || "x64";
    const amiPattern = AMI_PATTERNS[arch] ?? AMI_PATTERNS["x64"];

    // Instance tags
    const instanceTags: Record<string, string> = {
      Name: `ark-compute-${hostName}`,
      Component: "ark",
      ...(opts.tags ?? {}),
    };

    // Resolve AMI — latest Ubuntu 22.04 for the target architecture
    const ami = aws.ec2.getAmi({
      mostRecent: true,
      owners: ["099720109477"], // Canonical
      filters: [
        { name: "name", values: [amiPattern] },
        { name: "virtualization-type", values: ["hvm"] },
      ],
    });

    // Security group — use provided or create one
    let sgIds: pulumi.Input<string>[];

    if (opts.securityGroupId) {
      sgIds = [opts.securityGroupId];
    } else if (opts.subnetId) {
      // Look up VPC from the subnet so the SG is in the right VPC
      const subnetInfo = aws.ec2.getSubnet({ id: opts.subnetId });
      const vpcInfo = subnetInfo.then((s) => aws.ec2.getVpc({ id: s.vpcId }));

      const allowedCidrs = vpcInfo.then((v) => [v.cidrBlock, ...VPN_CIDRS]);

      const sg = new aws.ec2.SecurityGroup(`ark-sg-${hostName}`, {
        vpcId: subnetInfo.then((s) => s.vpcId),
        description: `Ark compute ${hostName} - SSH access`,
        ingress: [
          {
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrBlocks: allowedCidrs,
            description: "SSH from VPC + VPN",
          },
        ],
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],
        tags: {
          Name: `ark-sg-${hostName}`,
          Component: "ark",
        },
      });

      sgIds = [sg.id];
    } else {
      // No subnet — use default VPC, allow SSH from anywhere
      const sg = new aws.ec2.SecurityGroup(`ark-sg-${hostName}`, {
        description: `Ark compute ${hostName} - SSH access`,
        ingress: [
          {
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrBlocks: ["0.0.0.0/0"],
            description: "SSH",
          },
        ],
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],
        tags: {
          Name: `ark-sg-${hostName}`,
          Component: "ark",
        },
      });

      sgIds = [sg.id];
    }

    // EC2 instance
    const instance = new aws.ec2.Instance("ark-compute", {
      instanceType,
      ami: ami.then((a) => a.id),
      keyName: opts.keyName,
      vpcSecurityGroupIds: sgIds,
      subnetId: opts.subnetId,
      userData: opts.userData,
      rootBlockDevice: {
        volumeSize: 256,
        volumeType: "gp3",
        deleteOnTermination: true,
      },
      tags: instanceTags,
    });

    // Return outputs — use privateIp when in a private subnet, publicIp otherwise
    return {
      ip: opts.subnetId ? instance.privateIp : instance.publicIp,
      instance_id: instance.id,
    };
  };
}

// ---------------------------------------------------------------------------
// provisionStack
// ---------------------------------------------------------------------------

/**
 * Provision an EC2 instance via Pulumi Automation API.
 *
 * Creates or selects a Pulumi stack named "ark-compute-{hostName}", defines
 * the EC2 resources inline, and runs `stack.up()` to deploy.
 */
export function ensurePulumi(onLog?: (msg: string) => void): void {
  const { execFileSync } = require("child_process");
  const { existsSync } = require("fs");
  const { join } = require("path");
  const { homedir: home } = require("os");

  // Check PATH first
  try {
    execFileSync("pulumi", ["version"], { stdio: "pipe", timeout: 5000 });
    return;
  } catch { /* not in PATH */ }

  // Check ~/.pulumi/bin (installed but not in PATH)
  const pulumiBin = join(home(), ".pulumi", "bin");
  const pulumiPath = join(pulumiBin, "pulumi");
  if (existsSync(pulumiPath)) {
    process.env.PATH = `${pulumiBin}:${process.env.PATH}`;
    return;
  }

  // Auto-install using curl + sh via execFileSync
  const log = onLog ?? (() => {});
  log("Pulumi CLI not found — installing...");
  try {
    // Download installer script, then run it
    execFileSync("bash", ["-c", "curl -fsSL https://get.pulumi.com | sh"], {
      stdio: "pipe",
      timeout: 120_000,
      env: { ...process.env, PULUMI_SKIP_UPDATE_CHECK: "true" },
    });
    process.env.PATH = `${pulumiBin}:${process.env.PATH}`;
    const version = execFileSync(pulumiPath, ["version"], { encoding: "utf-8", timeout: 5000 }).trim();
    log(`Pulumi ${version} installed`);
  } catch (e: any) {
    throw new Error(`Failed to install Pulumi: ${e.message ?? e}`);
  }
}

export async function provisionStack(
  hostName: string,
  opts: ProvisionStackOpts,
): Promise<ProvisionResult> {
  // Note: caller should run ensurePulumi() before calling this
  const arch = opts.arch ?? "x64";
  const region = opts.region ?? "us-east-1";
  const instanceType = resolveInstanceType(opts.size, arch);

  const sName = stackName(hostName);

  const program = makePulumiProgram(instanceType, hostName, {
    arch,
    keyName: opts.keyName,
    subnetId: opts.subnetId,
    securityGroupId: opts.securityGroupId,
    userData: opts.userData,
    tags: opts.tags,
  });

  const args: InlineProgramArgs = {
    stackName: sName,
    projectName: "ark-ec2",
    program,
  };

  const stack = await LocalWorkspace.createOrSelectStack(
    args,
    workspaceOpts(region, opts.awsProfile),
  );

  // Set AWS region in stack config
  await stack.setConfig("aws:region", { value: region } as ConfigValue);

  // Deploy — pipe Pulumi output to callback
  const log = opts.onOutput ?? console.log;
  const result = await stack.up({
    onOutput: (msg: string) => {
      const line = msg.trim();
      if (line) log(line);
    },
  });

  const ip = result.outputs["ip"]?.value as string | undefined ?? null;
  const instanceId = (result.outputs["instance_id"]?.value as string) ?? "";

  return {
    ip,
    instance_id: instanceId,
    stack_name: sName,
    key_name: opts.keyName,
  };
}

// ---------------------------------------------------------------------------
// destroyStack
// ---------------------------------------------------------------------------

/**
 * Destroy and remove the Pulumi stack for a given host.
 */
export async function destroyStack(
  hostName: string,
  opts?: DestroyStackOpts,
): Promise<void> {
  const region = opts?.region ?? "us-east-1";
  const sName = opts?.stackName ?? stackName(hostName);

  const args: InlineProgramArgs = {
    stackName: sName,
    projectName: "ark-ec2",
    program: async () => {},
  };

  const stack = await LocalWorkspace.selectStack(
    args,
    workspaceOpts(region, opts?.awsProfile),
  );

  await stack.destroy({ onOutput: console.log });
  await stack.workspace.removeStack(sName);
}
