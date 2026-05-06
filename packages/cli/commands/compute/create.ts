import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { allFlagSpecs, getFlagSpec } from "../../../core/compute/index.js";
import type { ProviderFlagOption } from "../../../core/compute/index.js";
import { getArkClient } from "../../app-client.js";

/**
 * Map a (kind, isolation) pair back to the legacy provider name our flag
 * specs key off. Mirrors the (now-deleted) `pairToProvider` helper. Kept
 * inline here because the flag-spec registry hasn't yet been re-keyed by
 * (kind, isolation) -- Task 6 of the cleanup will inline the per-provider
 * options entirely.
 */
function axesToFlagSpecKey(kind: string | undefined, isolation: string | undefined): string {
  if (!kind) return "local";
  if (kind === "local") {
    if (!isolation || isolation === "direct") return "local";
    if (isolation === "docker") return "docker";
    if (isolation === "devcontainer") return "devcontainer";
    if (isolation === "firecracker-in-container") return "firecracker";
    return "local";
  }
  if (kind === "ec2") {
    if (!isolation || isolation === "direct") return "ec2";
    if (isolation === "docker") return "ec2-docker";
    if (isolation === "devcontainer") return "ec2-devcontainer";
    if (isolation === "firecracker-in-container") return "ec2-firecracker";
    return "ec2";
  }
  if (kind === "firecracker") return "firecracker";
  if (kind === "k8s") return "k8s";
  if (kind === "k8s-kata") return "k8s-kata";
  return kind;
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

/**
 * Apply every registered provider's Commander options to `create`, de-duped
 * by flag header (docker `--image` and k8s `--image` are the same flag and
 * must only be registered once). Repeatable list-style flags get an
 * accumulator; everything else is a plain option (possibly with a default).
 */
function registerProviderFlags(cmd: Command): Command {
  const seen = new Set<string>();
  const appendToList = (val: string, acc: string[] = []) => {
    acc.push(val);
    return acc;
  };

  for (const spec of allFlagSpecs()) {
    for (const opt of spec.options) {
      const header = flagHeader(opt.flag);
      if (seen.has(header)) continue;
      seen.add(header);

      if (isRepeatableListOption(opt)) {
        cmd.option(opt.flag, opt.description, appendToList, [] as string[]);
      } else if (opt.default !== undefined) {
        cmd.option(opt.flag, opt.description, opt.default);
      } else {
        cmd.option(opt.flag, opt.description);
      }
    }
  }
  return cmd;
}

/** Extract the canonical long-flag header (eg `"--image"` from `"--image <image>"`). */
function flagHeader(flag: string): string {
  const parts = flag.trim().split(/\s+/);
  return parts[0] ?? flag;
}

/** Heuristic: repeatable flags say so in their description. Cheaper than a 2nd field. */
function isRepeatableListOption(opt: ProviderFlagOption): boolean {
  return /\(repeatable\)/i.test(opt.description);
}

export function registerCreateCommand(computeCmd: Command) {
  const createCmd = computeCmd
    .command("create")
    .description("Create a new compute resource (concrete target or reusable template)")
    .argument("<name>", "Compute name")
    .option("--kind <kind>", "Compute kind (local, firecracker, ec2, k8s, k8s-kata)")
    .option("--isolation <kind>", "Isolation kind (direct, docker, compose, devcontainer, firecracker-in-container)")
    // Unified-model: template vs concrete target is now just a flag.
    .option("--template", "Create a reusable template (blueprint) instead of a concrete compute target")
    .option("--no-prompt", "Skip interactive prompts (fail if required fields are missing)");

  // Per-provider flags come from the flag-spec registry; each provider owns
  // its own knobs via `packages/compute/flag-specs/*.ts`. Adding a new
  // provider means shipping a new flag spec -- this command does not change.
  registerProviderFlags(createCmd);

  createCmd.option("--from-template <name>", "Use a compute template as defaults").action(async (name, opts) => {
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

      // The flag-spec registry is still keyed by the legacy provider name;
      // map (kind, isolation) back to that key until Task 6 inlines the
      // per-provider options here. Unknown providers fall through to an
      // empty config with a warning.
      const flagSpecKey = axesToFlagSpecKey(kind, isolation);
      const spec = getFlagSpec(flagSpecKey);
      if (!spec) {
        console.log(chalk.yellow(`No flag spec for '${flagSpecKey}'; creating with empty config.`));
      }
      let config: Record<string, unknown> = spec ? spec.configFromFlags(opts) : {};

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

      if (spec) {
        for (const line of spec.displaySummary(config, opts)) {
          console.log(line);
        }
      }
    } catch (e: any) {
      console.log(chalk.red(`Failed to create compute: ${e.message}`));
    }
  });
}
