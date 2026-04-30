/**
 * `ark secrets describe <name>` -- show a secret's type, metadata,
 * description, and a one-line preview of where the secret will land at
 * dispatch time. Looks up both string secrets and blob secrets so the
 * same command works for either shape.
 *
 * No values are ever printed: this command is metadata-only by design.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { runAction } from "../_shared.js";
import { getInProcessApp } from "../../app-client.js";

/**
 * One-liner placement preview keyed by secret type. Reflects the phase
 * roadmap from the typed-secrets plan -- env-var is wired today; the
 * other types will fill in as the per-provider placers land.
 */
const PLACER_SUMMARY: Record<string, string> = {
  "env-var": "every provider exports as $name on the launcher",
  "ssh-private-key": "(Phase 2) EC2 places at ~/.ssh/id_<name>",
  "generic-blob": "(Phase 3) k8s mounts at metadata.target_path; others write files",
  "kubeconfig": "(Phase 3) only the k8s provisioner consumes this",
};

export function registerDescribeCommand(secretsCmd: Command): void {
  secretsCmd
    .command("describe <name>")
    .description("Print a secret's type, metadata, and the providers that will place it")
    .action(async (name: string) => {
      await runAction("secrets describe", async () => {
        const app = await getInProcessApp();
        const tenantId = app.config.authSection.defaultTenant ?? "default";
        const refs = await app.secrets.list(tenantId);
        const blobs = await app.secrets.listBlobsDetailed(tenantId);
        const ref = refs.find((r) => r.name === name) ?? blobs.find((r) => r.name === name);
        if (!ref) {
          console.error(chalk.red(`Secret '${name}' not found in tenant '${tenantId}'.`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.bold(ref.name));
        console.log(`  Type:        ${ref.type}`);
        console.log(`  Metadata:    ${JSON.stringify(ref.metadata)}`);
        console.log(`  Description: ${(ref as { description?: string }).description ?? ""}`);
        console.log(`  Updated:     ${ref.updated_at}`);
        console.log(`  Placement:   ${PLACER_SUMMARY[ref.type] ?? "unknown type"}`);
      });
    });
}
