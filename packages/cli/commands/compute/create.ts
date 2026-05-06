import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { INSTANCE_SIZES } from "../../../core/compute/ec2/provision.js";
import { getArkClient } from "../../app-client.js";

const DEFAULT_DOCKER_IMAGE = "ubuntu:22.04";

/**
 * Commander accumulator for repeatable flags (`--volume`, `--aws-tag`).
 */
function collect(val: string, prev: string[] = []): string[] {
  prev.push(val);
  return prev;
}

/**
 * Parse repeatable `--aws-tag key=value` entries into an object. Tolerates
 * malformed entries (silently dropped) so a stray `--aws-tag foo` doesn't
 * crash compute creation.
 */
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

/**
 * Build the provider-config payload from raw Commander opts. Dispatches on
 * `(kind, isolation)` -- previously the polymorphic flag-spec registry's job.
 *
 * Behavioural notes:
 *   - K8s has NO silent defaults for context/namespace/image: a misconfigured
 *     target should fail at create time, not provision pods into the wrong
 *     cluster. See the comment at the top of the k8s case.
 *   - Docker isolation (under `local` or `ec2`) defaults the image to
 *     `ubuntu:22.04` to match historical behaviour.
 *   - Devcontainer / firecracker-in-container isolations are passthrough --
 *     the isolation layer reads its own knobs from the workspace, no extra
 *     CLI flags today.
 */
function configFromFlags(kind: string, isolation: string, opts: Record<string, any>): Record<string, unknown> {
  switch (kind) {
    case "local": {
      if (isolation === "docker") {
        const image = typeof opts.image === "string" && opts.image ? opts.image : DEFAULT_DOCKER_IMAGE;
        const volumes = Array.isArray(opts.volume) ? (opts.volume as string[]) : [];
        return {
          image,
          ...(opts.devcontainer ? { devcontainer: true } : {}),
          ...(volumes.length ? { volumes } : {}),
        };
      }
      // direct / devcontainer / firecracker-in-container -- no CLI knobs.
      return {};
    }

    case "ec2": {
      const tags = parseTags(opts.awsTag);
      return {
        size: opts.size,
        arch: opts.arch,
        region: opts.awsRegion,
        ...(opts.awsProfile ? { aws_profile: opts.awsProfile } : {}),
        ...(opts.awsSubnetId ? { subnet_id: opts.awsSubnetId } : {}),
        ...(Object.keys(tags).length ? { tags } : {}),
      };
    }

    case "k8s":
    case "k8s-kata": {
      // No silent defaults -- see commit 91217e89. Empty fields stay empty so
      // a misconfigured target fails fast instead of provisioning into the
      // wrong cluster / namespace.
      const cfg: Record<string, unknown> = {};
      if (opts.context) cfg.context = opts.context;
      if (opts.namespace) cfg.namespace = opts.namespace;
      if (opts.image) cfg.image = opts.image;
      if (opts.kubeconfig) cfg.kubeconfig = opts.kubeconfig;
      if (opts.serviceAccount) cfg.serviceAccount = opts.serviceAccount;
      if (opts.runtimeClass) cfg.runtimeClassName = opts.runtimeClass;
      if (opts.cpu || opts.memory) {
        cfg.resources = {
          ...(opts.cpu ? { cpu: String(opts.cpu) } : {}),
          ...(opts.memory ? { memory: String(opts.memory) } : {}),
        };
      }
      return cfg;
    }

    case "firecracker":
      // Local Firecracker derives kernel/rootfs/networking from host state;
      // no CLI-exposed knobs today.
      return {};

    default:
      return {};
  }
}

/**
 * Render the post-create summary lines for a freshly created compute. The
 * shapes mirror the per-provider `displaySummary` they replaced; updates here
 * should match what users see in `ark compute show`.
 */
function displaySummary(
  kind: string,
  isolation: string,
  config: Record<string, any>,
  opts: Record<string, any>,
): string[] {
  switch (kind) {
    case "local": {
      if (isolation === "docker") {
        const lines: string[] = [];
        lines.push(`  Image:    ${(config.image as string) ?? DEFAULT_DOCKER_IMAGE}`);
        if (config.devcontainer) lines.push(`  Devcontainer: yes`);
        const volumes = config.volumes as string[] | undefined;
        if (volumes?.length) lines.push(`  Volumes:  ${volumes.join(", ")}`);
        return lines;
      }
      return [];
    }

    case "ec2": {
      const lines: string[] = [];
      const size = (opts.size as string | undefined) ?? (config.size as string | undefined);
      let sizeLabel = size ?? "";
      if (size) {
        const tier = INSTANCE_SIZES[size];
        if (tier) sizeLabel = tier.label;
      }
      lines.push(`  Size:     ${sizeLabel}`);
      lines.push(`  Arch:     ${(opts.arch as string | undefined) ?? (config.arch as string | undefined) ?? ""}`);
      lines.push(
        `  Region:   ${(opts.awsRegion as string | undefined) ?? (config.region as string | undefined) ?? ""}`,
      );
      return lines;
    }

    case "k8s":
    case "k8s-kata": {
      const lines: string[] = [];
      if (config.context) lines.push(`  Context:    ${config.context}`);
      if (config.namespace) lines.push(`  Namespace:  ${config.namespace}`);
      if (config.image) lines.push(`  Image:      ${config.image}`);
      if (config.serviceAccount) lines.push(`  ServiceAcc: ${config.serviceAccount}`);
      if (config.runtimeClassName) lines.push(`  Runtime:    ${config.runtimeClassName}`);
      if (config.kubeconfig) lines.push(`  Kubeconfig: ${config.kubeconfig}`);
      const res = config.resources as { cpu?: string; memory?: string } | undefined;
      if (res?.cpu || res?.memory) lines.push(`  Resources:  cpu=${res?.cpu ?? "-"} mem=${res?.memory ?? "-"}`);
      return lines;
    }

    case "firecracker":
      return [];

    default:
      return [];
  }
}

/**
 * Minimal raw-readline prompt. Returns the trimmed user input or the
 * `fallback` when the user just hits enter. Respects `--no-prompt` and
 * non-TTY invocations by returning `fallback` without blocking.
 */
async function prompt(question: string, fallback: string, allowed?: string[]): Promise<string> {
  if (!process.stdin.isTTY || process.env.ARK_NO_PROMPT === "1") return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (raw: string) => {
        const trimmed = (raw ?? "").trim();
        if (!trimmed) return resolve(fallback);
        if (allowed && allowed.length && !allowed.includes(trimmed)) return resolve(fallback);
        resolve(trimmed);
      });
    });
  } finally {
    rl.close();
  }
}

/**
 * Walk the user through the required k8s target fields when the caller
 * omitted them. No-op on a non-TTY. Mutates `opts` in place with the
 * picked context / namespace / image.
 */
async function promptK8sIfNeeded(opts: Record<string, any>): Promise<void> {
  if (opts.noPrompt) return;
  if (!process.stdin.isTTY) return;
  const needsContext = !opts.context;
  const needsNamespace = !opts.namespace;
  const needsImage = !opts.image;
  if (!needsContext && !needsNamespace && !needsImage) return;

  let contexts: Array<{ name: string }> = [];
  let currentContext = "";
  if (needsContext) {
    try {
      const ark = await getArkClient();
      const discovery = await ark.k8sDiscover();
      contexts = (discovery?.contexts ?? []) as Array<{ name: string }>;
      currentContext = (discovery?.current ?? "") as string;
      if (contexts.length) {
        console.log(chalk.bold("\nAvailable k8s contexts:"));
        contexts.forEach((c, i) =>
          console.log(`  ${i + 1}) ${c.name}${c.name === currentContext ? " (current)" : ""}`),
        );
      }
    } catch (e: any) {
      console.log(chalk.dim(`(k8s/discover unavailable: ${e.message}) -- enter context manually`));
    }
    const ctx = await prompt(
      `Context [${currentContext || "enter name"}]: `,
      currentContext || "",
      contexts.length ? contexts.map((c) => c.name) : undefined,
    );
    if (ctx) opts.context = ctx;
  }
  if (needsNamespace) {
    opts.namespace = await prompt("Namespace [ark]: ", "ark");
  }
  if (needsImage) {
    opts.image = await prompt("Image [ghcr.io/ytarasova/ark:latest]: ", "ghcr.io/ytarasova/ark:latest");
  }
}

export function registerCreateCommand(computeCmd: Command) {
  computeCmd
    .command("create")
    .description("Create a new compute resource (concrete target or reusable template)")
    .argument("<name>", "Compute name")
    // Two-axis target.
    .option("--kind <kind>", "Compute kind (local, firecracker, ec2, k8s, k8s-kata)")
    .option("--isolation <kind>", "Isolation kind (direct, docker, compose, devcontainer, firecracker-in-container)")
    // Common.
    .option("--template", "Create a reusable template (blueprint) instead of a concrete compute target")
    .option("--no-prompt", "Skip interactive prompts (fail if required fields are missing)")
    .option("--from-template <name>", "Use a compute template as defaults")
    // Docker / devcontainer (isolation=docker, plus k8s --image).
    .option("--image <image>", "Container image (docker isolation default: ubuntu:22.04; k8s pod image)")
    .option("--devcontainer", "Use devcontainer.json from project")
    .option("--volume <mount>", "Extra volume mount (repeatable)", collect, [] as string[])
    // EC2.
    .option(
      "--size <size>",
      "Instance size: xs (2vCPU/8GB), s (4/16), m (8/32), l (16/64), xl (32/128), xxl (48/192), xxxl (64/256)",
      "m",
    )
    .option("--arch <arch>", "Architecture: x64, arm", "x64")
    .option("--aws-region <region>", "AWS region", "us-east-1")
    .option("--aws-profile <profile>", "AWS profile")
    .option("--aws-subnet-id <id>", "AWS subnet ID")
    .option("--aws-tag <key=value>", "AWS tag (repeatable)", collect, [] as string[])
    // K8s.
    .option("--context <name>", "Kubeconfig context (cluster) -- required for k8s")
    .option("--namespace <ns>", "K8s namespace -- required for k8s")
    .option("--kubeconfig <path>", "Path to kubeconfig (default: in-cluster or ~/.kube/config)")
    .option("--service-account <sa>", "Pod service account name (for IRSA, etc.)")
    .option("--runtime-class <class>", "K8s runtime class (e.g. kata-fc for Firecracker)")
    .option("--cpu <amt>", "CPU request/limit (e.g. 2 or 500m)")
    .option("--memory <amt>", "Memory request/limit (e.g. 4Gi)")
    .action(async (name, opts) => {
      let kind: string | undefined = opts.kind;
      let isolation: string | undefined = opts.isolation;

      // Default when nothing is specified: local + direct (local auto-created).
      if (!kind && !isolation) {
        kind = "local";
        isolation = "direct";
      }
      if (!isolation) {
        isolation = "direct";
      }

      // Templates don't need the "local is auto-created" guard -- a local
      // template is fine, it'll never be provisioned, only cloned from.
      if (!opts.template && kind === "local" && isolation === "direct" && !opts.fromTemplate) {
        console.log(
          chalk.red("Local compute is auto-created. Use --kind ec2 (or another remote kind), or --from-template."),
        );
        return;
      }

      // K8s interactive prompts when the user omitted required fields.
      // Skip on non-TTY and when --no-prompt is passed.
      if ((kind === "k8s" || kind === "k8s-kata") && !opts.fromTemplate) {
        await promptK8sIfNeeded(opts);
      }

      try {
        const ark = await getArkClient();

        // Apply template defaults if specified.
        if (opts.fromTemplate) {
          const tmpl = await ark.computeTemplateGet(opts.fromTemplate);
          if (!tmpl) {
            console.log(chalk.red(`Template '${opts.fromTemplate}' not found.`));
            return;
          }
          // Template wins on kind/isolation unless user overrode them.
          const tCompute = (tmpl as { compute?: string }).compute;
          const tIsolation = (tmpl as { isolation?: string }).isolation;
          if (!opts.kind && tCompute) kind = tCompute;
          if (!opts.isolation && tIsolation) isolation = tIsolation;
        }

        let config: Record<string, unknown> = configFromFlags(kind ?? "", isolation ?? "", opts);

        // Merge template config as base, user options override.
        if (opts.fromTemplate) {
          const tmpl = await ark.computeTemplateGet(opts.fromTemplate);
          if (tmpl?.config) {
            config = { ...tmpl.config, ...config };
          }
        }

        const compute = await ark.computeCreate({
          name,
          compute: kind,
          isolation,
          config,
          ...(opts.template ? { is_template: true } : {}),
        } as any);

        // The kind-label is the most important thing a user sees -- make it
        // unambiguous whether they just made a template or a concrete target.
        const ck = (compute as any).compute_kind ?? "-";
        const ik = (compute as any).isolation_kind ?? "-";
        const kindLabel = opts.template ? "TEMPLATE" : "COMPUTE";
        console.log(chalk.green(`Created ${kindLabel} '${compute.name}' (${ck}/${ik})`));
        console.log(`  Compute:    ${ck}`);
        console.log(`  Isolation:  ${ik}`);
        console.log(`  Status:     ${compute.status}`);

        for (const line of displaySummary(kind ?? "", isolation ?? "", config, opts)) {
          console.log(line);
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed to create compute: ${e.message}`));
      }
    });
}
