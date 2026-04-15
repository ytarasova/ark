/**
 * CLI commands for tenant compute policy management.
 *
 * ark tenant policy set <tenant-id> --providers k8s,k8s-kata --max-sessions 20
 * ark tenant policy get <tenant-id>
 * ark tenant policy list
 * ark tenant policy delete <tenant-id>
 */

import type { Command } from "commander";
import chalk from "chalk";
import * as core from "../../core/index.js";
import { TenantPolicyManager } from "../../core/auth/index.js";

export function registerTenantCommands(program: Command) {
  const tenant = program.command("tenant").description("Manage tenant settings");
  const policy = tenant.command("policy").description("Manage tenant compute policies");

  policy
    .command("set")
    .description("Set compute policy for a tenant")
    .argument("<tenant-id>", "Tenant ID")
    .option("--providers <list>", "Comma-separated allowed providers (e.g. k8s,ec2,e2b)")
    .option("--default-provider <provider>", "Default provider", "k8s")
    .option("--max-sessions <n>", "Maximum concurrent sessions", "10")
    .option("--max-cost <usd>", "Maximum daily cost in USD")
    .action((tenantId, opts) => {
      try {
        const app = core.getApp();
        const pm = new TenantPolicyManager(app.db);

        const allowedProviders = opts.providers
          ? opts.providers
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean)
          : [];

        pm.setPolicy({
          tenant_id: tenantId,
          allowed_providers: allowedProviders,
          default_provider: opts.defaultProvider,
          max_concurrent_sessions: parseInt(opts.maxSessions, 10),
          max_cost_per_day_usd: opts.maxCost ? parseFloat(opts.maxCost) : null,
          compute_pools: [],
        });

        console.log(chalk.green(`Policy set for tenant '${tenantId}'`));
        console.log(`  Allowed providers: ${allowedProviders.length > 0 ? allowedProviders.join(", ") : "(all)"}`);
        console.log(`  Default provider:  ${opts.defaultProvider}`);
        console.log(`  Max sessions:      ${opts.maxSessions}`);
        if (opts.maxCost) {
          console.log(`  Max daily cost:    $${opts.maxCost}`);
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  policy
    .command("get")
    .description("Get compute policy for a tenant")
    .argument("<tenant-id>", "Tenant ID")
    .action((tenantId) => {
      try {
        const app = core.getApp();
        const pm = new TenantPolicyManager(app.db);
        const p = pm.getPolicy(tenantId);

        if (!p) {
          console.log(chalk.dim(`No explicit policy for tenant '${tenantId}'. Default policy applies.`));
          console.log(chalk.dim("  Allowed providers: (all)"));
          console.log(chalk.dim("  Default provider:  k8s"));
          console.log(chalk.dim("  Max sessions:      10"));
          return;
        }

        console.log(chalk.bold(`Policy for tenant '${tenantId}'`));
        console.log(
          `  Allowed providers: ${p.allowed_providers.length > 0 ? p.allowed_providers.join(", ") : "(all)"}`,
        );
        console.log(`  Default provider:  ${p.default_provider}`);
        console.log(`  Max sessions:      ${p.max_concurrent_sessions}`);
        if (p.max_cost_per_day_usd !== null) {
          console.log(`  Max daily cost:    $${p.max_cost_per_day_usd}`);
        }
        if (p.compute_pools.length > 0) {
          console.log(`  Compute pools:`);
          for (const pool of p.compute_pools) {
            console.log(`    - ${pool.pool_name} (${pool.provider}) min=${pool.min} max=${pool.max}`);
          }
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  policy
    .command("list")
    .description("List all tenant compute policies")
    .action(() => {
      try {
        const app = core.getApp();
        const pm = new TenantPolicyManager(app.db);
        const policies = pm.listPolicies();

        if (!policies.length) {
          console.log(chalk.dim("No tenant policies configured. Default policy applies to all tenants."));
          return;
        }

        console.log(
          `  ${"TENANT".padEnd(20)} ${"PROVIDERS".padEnd(25)} ${"DEFAULT".padEnd(10)} ${"MAX SESS".padEnd(10)} COST/DAY`,
        );
        for (const p of policies) {
          const providers = p.allowed_providers.length > 0 ? p.allowed_providers.join(",") : "(all)";
          const cost = p.max_cost_per_day_usd !== null ? `$${p.max_cost_per_day_usd}` : "-";
          console.log(
            `  ${p.tenant_id.padEnd(20)} ${providers.padEnd(25)} ${p.default_provider.padEnd(10)} ${String(p.max_concurrent_sessions).padEnd(10)} ${cost}`,
          );
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  policy
    .command("delete")
    .description("Delete compute policy for a tenant")
    .argument("<tenant-id>", "Tenant ID")
    .action((tenantId) => {
      try {
        const app = core.getApp();
        const pm = new TenantPolicyManager(app.db);
        const deleted = pm.deletePolicy(tenantId);

        if (deleted) {
          console.log(chalk.green(`Policy deleted for tenant '${tenantId}'`));
        } else {
          console.log(chalk.red(`No policy found for tenant '${tenantId}'`));
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });
}
