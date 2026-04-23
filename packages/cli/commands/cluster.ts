/**
 * `ark cluster` -- list the effective clusters visible to the current tenant.
 *
 *   ark cluster list              # default table output
 *   ark cluster list --json       # raw JSON
 *
 * Agent G / Phase 1. Admin-only tenant overrides are managed via
 * `ark tenant config *` (see ./tenant-config.ts).
 */

import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../app-client.js";
import { runAction } from "./_shared.js";

export function registerClusterCommands(program: Command): void {
  const cluster = program.command("cluster").description("List Kubernetes clusters visible to this tenant");

  cluster
    .command("list")
    .description("List effective clusters (system + tenant overrides)")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      await runAction("cluster list", async () => {
        const ark = await getArkClient();
        const clusters = await ark.clusterList();
        if (opts.json) {
          console.log(JSON.stringify(clusters, null, 2));
          return;
        }
        if (!clusters.length) {
          console.log(chalk.dim("No clusters configured."));
          return;
        }
        console.log(`  ${"NAME".padEnd(24)} ${"KIND".padEnd(10)} ${"NAMESPACE".padEnd(16)} ENDPOINT`);
        for (const c of clusters) {
          console.log(
            `  ${c.name.padEnd(24)} ${c.kind.padEnd(10)} ${(c.defaultNamespace ?? "-").padEnd(16)} ${c.apiEndpoint}`,
          );
        }
      });
    });
}
