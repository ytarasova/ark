/**
 * EC2 provisioning via direct AWS SDK calls.
 *
 * Lightweight AWS SDK operations: RunInstances, security groups, key pairs.
 * State is stored in compute.config (SQLite); no external state directory
 * needed.
 */

import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSubnetsCommand,
  DescribeImagesCommand,
  CreateTagsCommand,
  waitUntilInstanceRunning,
} from "@aws-sdk/client-ec2";
import { fromIni } from "@aws-sdk/credential-providers";

/**
 * Default IAM instance profile that grants the EC2 instance permission to
 * speak SSM (specifically the AmazonSSMManagedInstanceCore policy). The
 * conductor connects via SSM Session Manager, so the instance MUST have
 * this role attached or `aws ssm start-session` returns
 * `TargetNotConnected`.
 *
 * The user can override per-call via `ProvisionStackOpts.iamInstanceProfile`,
 * or globally via `ARK_EC2_INSTANCE_PROFILE`. If neither is set we use this
 * conventional name; callers are expected to pre-create it in their AWS
 * account (one-time setup, see docs/providers.md).
 */
const DEFAULT_INSTANCE_PROFILE = "ArkEC2SsmInstanceProfile";

// ---------------------------------------------------------------------------
// Instance size tiers - maps size label to [x64_type, arm_type]
// ---------------------------------------------------------------------------

export interface SizeTier {
  types: [string, string]; // [x64, arm]
  vcpu: number;
  memGb: number;
  label: string; // human-readable
}

export const INSTANCE_SIZES: Record<string, SizeTier> = {
  xs: { types: ["m6i.large", "m6g.large"], vcpu: 2, memGb: 8, label: "Extra Small (2 vCPU, 8 GB)" },
  s: { types: ["m6i.xlarge", "m6g.xlarge"], vcpu: 4, memGb: 16, label: "Small (4 vCPU, 16 GB)" },
  m: { types: ["m6i.2xlarge", "m6g.2xlarge"], vcpu: 8, memGb: 32, label: "Medium (8 vCPU, 32 GB)" },
  l: { types: ["m6i.4xlarge", "m6g.4xlarge"], vcpu: 16, memGb: 64, label: "Large (16 vCPU, 64 GB)" },
  xl: { types: ["m6i.8xlarge", "m6g.8xlarge"], vcpu: 32, memGb: 128, label: "X-Large (32 vCPU, 128 GB)" },
  xxl: { types: ["m6i.12xlarge", "m6g.12xlarge"], vcpu: 48, memGb: 192, label: "2X-Large (48 vCPU, 192 GB)" },
  xxxl: { types: ["m6i.16xlarge", "m6g.16xlarge"], vcpu: 64, memGb: 256, label: "4X-Large (64 vCPU, 256 GB)" },
};

// AMI name patterns by architecture
const AMI_PATTERNS: Record<string, string> = {
  x64: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*",
  arm: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-arm64-server-*",
};

// ---------------------------------------------------------------------------
// resolveInstanceType
// ---------------------------------------------------------------------------

export function resolveInstanceType(size?: string, arch: string = "x64", fallback: string = "m6i.2xlarge"): string {
  if (!size) return fallback;
  if (size in INSTANCE_SIZES) {
    const tier = INSTANCE_SIZES[size];
    return arch === "arm" ? tier.types[1] : tier.types[0];
  }
  return size;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisionResult {
  ip: string | null;
  instance_id: string;
  stack_name: string;
  sg_id?: string;
}

export interface ProvisionStackOpts {
  size?: string;
  arch?: string;
  region?: string;
  subnetId?: string;
  securityGroupId?: string;
  userData?: string;
  tags?: Record<string, string>;
  awsProfile?: string;
  /**
   * Name (or full ARN) of the IAM instance profile to attach. The profile's
   * role MUST have the AmazonSSMManagedInstanceCore policy or the conductor
   * cannot start an SSM session against the instance. Defaults to
   * `ARK_EC2_INSTANCE_PROFILE` env var, then to `DEFAULT_INSTANCE_PROFILE`.
   */
  iamInstanceProfile?: string;
  onOutput?: (msg: string) => void;
}

export interface DestroyStackOpts {
  region?: string;
  stackName?: string;
  awsProfile?: string;
  /** Resource IDs to clean up (from ProvisionResult stored in compute config) */
  sg_id?: string;
  instance_id?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(region: string, awsProfile?: string): EC2Client {
  return new EC2Client({
    region,
    ...(awsProfile ? { credentials: fromIni({ profile: awsProfile }) } : {}),
  });
}

async function findLatestAmi(client: EC2Client, arch: string): Promise<string> {
  const pattern = AMI_PATTERNS[arch] ?? AMI_PATTERNS["x64"];
  const result = await client.send(
    new DescribeImagesCommand({
      Owners: ["099720109477"], // Canonical
      Filters: [
        { Name: "name", Values: [pattern] },
        { Name: "virtualization-type", Values: ["hvm"] },
        { Name: "state", Values: ["available"] },
      ],
    }),
  );

  const images = (result.Images ?? []).sort((a, b) => (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""));
  if (images.length === 0) throw new Error(`No AMI found for pattern: ${pattern}`);
  return images[0].ImageId!;
}

// ---------------------------------------------------------------------------
// provisionStack
// ---------------------------------------------------------------------------

export async function provisionStack(hostName: string, opts: ProvisionStackOpts): Promise<ProvisionResult> {
  const arch = opts.arch ?? "x64";
  const region = opts.region ?? "us-east-1";
  const instanceType = resolveInstanceType(opts.size, arch);
  const log = opts.onOutput ?? (() => {});
  const client = createClient(region, opts.awsProfile);

  const tags = [
    { Key: "Name", Value: `ark-compute-${hostName}` },
    { Key: "Component", Value: "ark" },
    ...Object.entries(opts.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
  ];

  // 1. Find AMI
  log("Finding latest Ubuntu 22.04 AMI...");
  const amiId = await findLatestAmi(client, arch);
  log(`AMI: ${amiId}`);

  // 2. Security group.
  //
  // SSM transport: the SG has NO ingress rules. All conductor->instance
  // traffic flows out of the instance over HTTPS to
  // ssm.<region>.amazonaws.com via the SSM agent; arkd HTTP -- when the
  // conductor needs it -- is reached via an SSM port-forward
  // (`AWS-StartPortForwardingSession`) bound to a local-side port on the
  // conductor. So nothing inbound is necessary.
  let sgId = opts.securityGroupId;
  let createdSg = false;

  if (!sgId) {
    log("Creating security group (no ingress rules -- SSM-only)...");
    const sgParams: any = {
      GroupName: `ark-sg-${hostName}-${Date.now()}`,
      Description: `Ark compute ${hostName} - SSM-only (no inbound)`,
    };

    if (opts.subnetId) {
      const subnetResult = await client.send(new DescribeSubnetsCommand({ SubnetIds: [opts.subnetId] }));
      const vpcId = subnetResult.Subnets?.[0]?.VpcId;
      if (vpcId) sgParams.VpcId = vpcId;
    }

    const sgResult = await client.send(new CreateSecurityGroupCommand(sgParams));
    sgId = sgResult.GroupId!;
    createdSg = true;

    await client.send(
      new CreateTagsCommand({
        Resources: [sgId],
        Tags: [
          { Key: "Name", Value: `ark-sg-${hostName}` },
          { Key: "Component", Value: "ark" },
        ],
      }),
    );

    log(`Security group: ${sgId}`);
  }

  // 3. Launch instance.
  //
  // We attach an IAM instance profile so the instance can register with SSM
  // (AmazonSSMManagedInstanceCore policy). The conductor's transport is a
  // Session Manager port-forward, which fails with `TargetNotConnected` when
  // the instance lacks SSM permissions. The IAM profile is expected to exist
  // already in the AWS account; if it doesn't, RunInstances returns
  // `InvalidParameterValue: Invalid IAM Instance Profile name`, and we
  // re-throw with CLI-friendly remediation.
  const iamProfile = opts.iamInstanceProfile ?? process.env.ARK_EC2_INSTANCE_PROFILE ?? DEFAULT_INSTANCE_PROFILE;

  log(`Launching ${instanceType} instance (IAM profile: ${iamProfile})...`);
  let runResult;
  try {
    runResult = await client.send(
      new RunInstancesCommand({
        ImageId: amiId,
        InstanceType: instanceType as import("@aws-sdk/client-ec2")._InstanceType,
        MinCount: 1,
        MaxCount: 1,
        // No KeyName: pure SSM transport doesn't need an SSH keypair.
        // The SSM agent + IAM role (AmazonSSMManagedInstanceCore) is the
        // entire authentication contract.
        // IamInstanceProfile takes either Name or Arn. We pass Name for
        // anything that doesn't look like an ARN.
        IamInstanceProfile: iamProfile.startsWith("arn:") ? { Arn: iamProfile } : { Name: iamProfile },
        // No NetworkInterfaces block + SubnetId-only -- the subnet's
        // `MapPublicIpOnLaunch` setting wins. For a private subnet, no
        // public IP is allocated, which is exactly what SSM transport needs.
        SecurityGroupIds: sgId ? [sgId] : undefined,
        SubnetId: opts.subnetId,
        UserData: opts.userData ? Buffer.from(opts.userData).toString("base64") : undefined,
        BlockDeviceMappings: [
          {
            DeviceName: "/dev/sda1",
            Ebs: { VolumeSize: 256, VolumeType: "gp3", DeleteOnTermination: true },
          },
        ],
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: tags,
          },
        ],
      }),
    );
  } catch (err: any) {
    const code = err?.Code ?? err?.name ?? "";
    const msg = err?.message ?? String(err);
    if (code.includes("IamInstanceProfile") || /IAM Instance Profile/i.test(msg)) {
      throw new Error(
        `EC2 launch failed: IAM instance profile '${iamProfile}' is missing or unauthorized. ` +
          `Create one in your AWS account with the AmazonSSMManagedInstanceCore policy attached, ` +
          `or set ARK_EC2_INSTANCE_PROFILE / pass --iam-instance-profile to point to an existing profile. ` +
          `Original error: ${msg}`,
      );
    }
    throw err;
  }

  const instanceId = runResult.Instances?.[0]?.InstanceId;
  if (!instanceId) throw new Error("Failed to launch EC2 instance -- no instance ID returned");

  log(`Instance launched: ${instanceId}`);

  // 4. Wait for running state
  log("Waiting for instance to reach running state...");
  await waitUntilInstanceRunning(
    { client, maxWaitTime: 300, minDelay: 5, maxDelay: 10 },
    { InstanceIds: [instanceId] },
  );

  // 5. Capture IP address for legacy back-compat (some callers still log it
  // / use it for codegraph HTTP). Not required for SSM transport.
  const descResult = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const instance = descResult.Reservations?.[0]?.Instances?.[0];
  const ip = instance?.PrivateIpAddress ?? instance?.PublicIpAddress ?? null;

  log(`Instance running: ${instanceId}${ip ? ` (private IP: ${ip})` : ""}`);

  return {
    ip,
    instance_id: instanceId,
    stack_name: `ark-compute-${hostName}`,
    sg_id: createdSg ? sgId : undefined,
  };
}

// ---------------------------------------------------------------------------
// destroyStack
// ---------------------------------------------------------------------------

export async function destroyStack(hostName: string, opts?: DestroyStackOpts): Promise<void> {
  const region = opts?.region ?? "us-east-1";
  const client = createClient(region, opts?.awsProfile);

  const instanceId = opts?.instance_id;
  if (instanceId) {
    process.stderr.write(`[ec2] Terminating instance ${instanceId}...\n`);
    try {
      await client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    } catch (e: any) {
      console.error(`Failed to terminate instance: ${e.message}`);
    }
  }

  // Clean up security group (if we created it)
  const sgId = opts?.sg_id;
  if (sgId) {
    // Wait a moment for instance to start terminating before deleting SG
    await new Promise((r) => setTimeout(r, 5000));
    try {
      await client.send(new DeleteSecurityGroupCommand({ GroupId: sgId }));
    } catch (e: any) {
      console.error(`Failed to delete security group ${sgId}: ${e.message}`);
    }
  }
}
