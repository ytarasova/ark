/**
 * EC2 provisioning via direct AWS SDK calls.
 *
 * Replaces the former Pulumi Automation API with lightweight AWS SDK
 * operations. State is stored in compute.config (SQLite), no external
 * state directory needed.
 */

import { readFileSync } from "node:fs";
import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  DeleteSecurityGroupCommand,
  ImportKeyPairCommand,
  DeleteKeyPairCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  DescribeImagesCommand,
  CreateTagsCommand,
  waitUntilInstanceRunning,
} from "@aws-sdk/client-ec2";
import { fromIni } from "@aws-sdk/credential-providers";

// ---------------------------------------------------------------------------
// Instance size tiers - maps size label to [x64_type, arm_type]
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

// ---------------------------------------------------------------------------
// resolveInstanceType
// ---------------------------------------------------------------------------

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
  /** Resource IDs to clean up (from ProvisionResult stored in compute config) */
  sg_id?: string;
  key_name?: string;
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
  const result = await client.send(new DescribeImagesCommand({
    Owners: ["099720109477"], // Canonical
    Filters: [
      { Name: "name", Values: [pattern] },
      { Name: "virtualization-type", Values: ["hvm"] },
      { Name: "state", Values: ["available"] },
    ],
  }));

  const images = (result.Images ?? []).sort((a, b) =>
    (b.CreationDate ?? "").localeCompare(a.CreationDate ?? "")
  );
  if (images.length === 0) throw new Error(`No AMI found for pattern: ${pattern}`);
  return images[0].ImageId!;
}

// ---------------------------------------------------------------------------
// ensurePulumi - no longer needed, kept as no-op for backward compat
// ---------------------------------------------------------------------------

export async function ensurePulumi(_onLog?: (msg: string) => void): Promise<void> {
  // No-op: Pulumi is no longer required. Direct AWS SDK calls are used.
}

// ---------------------------------------------------------------------------
// provisionStack
// ---------------------------------------------------------------------------

export async function provisionStack(
  hostName: string,
  opts: ProvisionStackOpts,
): Promise<ProvisionResult> {
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

  // 2. Security group
  let sgId = opts.securityGroupId;
  let createdSg = false;

  if (!sgId) {
    log("Creating security group...");
    const sgParams: any = {
      GroupName: `ark-sg-${hostName}-${Date.now()}`,
      Description: `Ark compute ${hostName} - SSH access`,
    };

    if (opts.subnetId) {
      const subnetResult = await client.send(new DescribeSubnetsCommand({ SubnetIds: [opts.subnetId] }));
      const vpcId = subnetResult.Subnets?.[0]?.VpcId;
      if (vpcId) sgParams.VpcId = vpcId;
    }

    const sgResult = await client.send(new CreateSecurityGroupCommand(sgParams));
    sgId = sgResult.GroupId!;
    createdSg = true;

    // Determine ingress CIDR
    let ingressCidr = "0.0.0.0/0";
    if (opts.subnetId) {
      const subnetResult = await client.send(new DescribeSubnetsCommand({ SubnetIds: [opts.subnetId] }));
      const vpcId = subnetResult.Subnets?.[0]?.VpcId;
      if (vpcId) {
        const vpcResult = await client.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
        ingressCidr = vpcResult.Vpcs?.[0]?.CidrBlock ?? "0.0.0.0/0";
      }
    }

    await client.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [{
        IpProtocol: "tcp",
        FromPort: 22,
        ToPort: 22,
        IpRanges: [{ CidrIp: ingressCidr, Description: "SSH" }],
      }],
    }));

    await client.send(new CreateTagsCommand({
      Resources: [sgId],
      Tags: [{ Key: "Name", Value: `ark-sg-${hostName}` }, { Key: "Component", Value: "ark" }],
    }));

    log(`Security group: ${sgId}`);
  }

  // 3. SSH key pair
  let keyName = opts.keyName;
  let createdKey = false;

  if (!keyName && opts.sshKeyPath) {
    const pubKeyPath = `${opts.sshKeyPath}.pub`;
    const pubKey = readFileSync(pubKeyPath, "utf-8").trim();
    keyName = `ark-${hostName}`;

    try {
      await client.send(new ImportKeyPairCommand({
        KeyName: keyName,
        PublicKeyMaterial: Buffer.from(pubKey),
      }));
      createdKey = true;
    } catch (e: any) {
      if (e.Code === "InvalidKeyPair.Duplicate") {
        // Key already exists — reuse it
        log(`Key pair ${keyName} already exists, reusing`);
      } else {
        throw e;
      }
    }

    log(`Key pair: ${keyName}`);
  }

  // 4. Launch instance
  log(`Launching ${instanceType} instance...`);
  const runResult = await client.send(new RunInstancesCommand({
    ImageId: amiId,
    InstanceType: instanceType as any,
    MinCount: 1,
    MaxCount: 1,
    KeyName: keyName,
    SecurityGroupIds: sgId ? [sgId] : undefined,
    SubnetId: opts.subnetId,
    UserData: opts.userData ? Buffer.from(opts.userData).toString("base64") : undefined,
    BlockDeviceMappings: [{
      DeviceName: "/dev/sda1",
      Ebs: { VolumeSize: 256, VolumeType: "gp3", DeleteOnTermination: true },
    }],
    TagSpecifications: [{
      ResourceType: "instance",
      Tags: tags,
    }],
  }));

  const instanceId = runResult.Instances?.[0]?.InstanceId;
  if (!instanceId) throw new Error("Failed to launch EC2 instance — no instance ID returned");

  log(`Instance launched: ${instanceId}`);

  // 5. Wait for running state
  log("Waiting for instance to reach running state...");
  await waitUntilInstanceRunning(
    { client, maxWaitTime: 300, minDelay: 5, maxDelay: 10 },
    { InstanceIds: [instanceId] },
  );

  // 6. Get IP address
  const descResult = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const instance = descResult.Reservations?.[0]?.Instances?.[0];
  const ip = opts.subnetId
    ? instance?.PrivateIpAddress ?? null
    : instance?.PublicIpAddress ?? null;

  log(`Instance running: ${instanceId} (IP: ${ip ?? "pending"})`);

  return {
    ip,
    instance_id: instanceId,
    stack_name: `ark-compute-${hostName}`,
    sg_id: createdSg ? sgId : undefined,
    key_name: createdKey ? keyName : undefined,
  };
}

// ---------------------------------------------------------------------------
// destroyStack
// ---------------------------------------------------------------------------

export async function destroyStack(
  hostName: string,
  opts?: DestroyStackOpts,
): Promise<void> {
  const region = opts?.region ?? "us-east-1";
  const client = createClient(region, opts?.awsProfile);

  const instanceId = opts?.instance_id;
  if (instanceId) {
    console.log(`Terminating instance ${instanceId}...`);
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
    await new Promise(r => setTimeout(r, 5000));
    try {
      await client.send(new DeleteSecurityGroupCommand({ GroupId: sgId }));
    } catch (e: any) {
      console.error(`Failed to delete security group ${sgId}: ${e.message}`);
    }
  }

  // Clean up key pair (if we created it)
  const keyName = opts?.key_name;
  if (keyName) {
    try {
      await client.send(new DeleteKeyPairCommand({ KeyName: keyName }));
    } catch (e: any) {
      console.error(`Failed to delete key pair ${keyName}: ${e.message}`);
    }
  }
}
