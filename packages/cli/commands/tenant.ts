/**
 * CLI commands for tenant management:
 *   ark tenant list / create / update / delete / suspend / resume
 *   ark tenant policy *   (admin/tenant/policy/* over RPC)
 *
 * Every tenant-lifecycle command dispatches via ArkClient against the
 * admin/tenant/* handlers. Policy commands also go through ArkClient now
 * that admin/tenant/policy/* is wired on the server.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../app-client.js";

export function registerTenantCommands(program: Command) {
  const tenant = program.command("tenant").description("Manage tenant settings");
  const policy = tenant.command("policy").description("Manage tenant compute policies");

  // ── Tenant lifecycle ─────────────────────────────────────────────────

  tenant
    .command("list")
    .description("List all tenants")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const ark = await getArkClient();
        const rows = await ark.adminTenantList();
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (!rows.length) {
          console.log(chalk.dim("No tenants yet."));
          return;
        }
        console.log(`  ${"ID".padEnd(22)} ${"SLUG".padEnd(20)} ${"NAME".padEnd(24)} STATUS`);
        for (const t of rows) {
          console.log(`  ${t.id.padEnd(22)} ${t.slug.padEnd(20)} ${t.name.padEnd(24)} ${t.status}`);
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  tenant
    .command("create")
    .description("Create a new tenant")
    .argument("<slug>", "Kebab-case slug (unique)")
    .option("--name <name>", "Human-readable name (defaults to slug)")
    .option("--json", "Output raw JSON")
    .action(async (slug, opts) => {
      try {
        const ark = await getArkClient();
        const t = await ark.adminTenantCreate({ slug, name: opts.name ?? slug });
        if (opts.json) console.log(JSON.stringify(t, null, 2));
        else console.log(chalk.green(`Tenant created: ${t.id} (slug=${t.slug})`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  tenant
    .command("update")
    .description("Update a tenant's slug / name / status")
    .argument("<id>", "Tenant id or slug")
    .option("--slug <slug>", "New slug")
    .option("--name <name>", "New name")
    .option("--status <status>", "active | suspended | archived")
    .action(async (id, opts) => {
      try {
        const ark = await getArkClient();
        const current = await ark.adminTenantGet(id);
        if (!current) {
          console.log(chalk.red(`Tenant '${id}' not found`));
          return;
        }
        const t = await ark.adminTenantUpdate({
          id: current.id,
          ...(opts.slug ? { slug: opts.slug } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.status ? { status: opts.status } : {}),
        });
        console.log(chalk.green(`Tenant updated: ${t?.id}`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  tenant
    .command("delete")
    .description("Delete a tenant (cascades teams + memberships, leaves sessions/computes behind)")
    .argument("<id>", "Tenant id or slug")
    .action(async (id) => {
      try {
        const ark = await getArkClient();
        const current = await ark.adminTenantGet(id);
        if (!current) {
          console.log(chalk.red(`Tenant '${id}' not found`));
          return;
        }
        const ok = await ark.adminTenantDelete(current.id);
        console.log(ok ? chalk.green(`Tenant deleted: ${current.id}`) : chalk.red("Delete failed"));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  tenant
    .command("suspend")
    .description("Set tenant status to 'suspended'")
    .argument("<id>", "Tenant id or slug")
    .action(async (id) => {
      try {
        const ark = await getArkClient();
        const current = await ark.adminTenantGet(id);
        if (!current) {
          console.log(chalk.red(`Tenant '${id}' not found`));
          return;
        }
        await ark.adminTenantSetStatus(current.id, "suspended");
        console.log(chalk.yellow(`Tenant '${current.id}' suspended`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  tenant
    .command("resume")
    .description("Set tenant status to 'active'")
    .argument("<id>", "Tenant id or slug")
    .action(async (id) => {
      try {
        const ark = await getArkClient();
        const current = await ark.adminTenantGet(id);
        if (!current) {
          console.log(chalk.red(`Tenant '${id}' not found`));
          return;
        }
        await ark.adminTenantSetStatus(current.id, "active");
        console.log(chalk.green(`Tenant '${current.id}' active`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  // ── Policy subcommands (RPC: admin/tenant/policy/*) ──────────────────

  policy
    .command("set")
    .description("Set compute policy for a tenant")
    .argument("<tenant-id>", "Tenant ID")
    .option("--providers <list>", "Comma-separated allowed providers (e.g. k8s,ec2)")
    .option("--default-provider <provider>", "Default provider", "k8s")
    .option("--max-sessions <n>", "Maximum concurrent sessions", "10")
    .option("--max-cost <usd>", "Maximum daily cost in USD")
    .action(async (tenantId, opts) => {
      try {
        const ark = await getArkClient();
        const allowedProviders = opts.providers
          ? opts.providers
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean)
          : [];

        await ark.tenantPolicySet({
          tenant_id: tenantId,
          allowed_providers: allowedProviders,
          default_provider: opts.defaultProvider,
          max_concurrent_sessions: parseInt(opts.maxSessions, 10),
          max_cost_per_day_usd: opts.maxCost ? parseFloat(opts.maxCost) : null,
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
    .action(async (tenantId) => {
      try {
        const ark = await getArkClient();
        const p = await ark.tenantPolicyGet(tenantId);

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
    .action(async () => {
      try {
        const ark = await getArkClient();
        const policies = await ark.tenantPolicyList();

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
    .action(async (tenantId) => {
      try {
        const ark = await getArkClient();
        const deleted = await ark.tenantPolicyDelete(tenantId);

        if (deleted) {
          console.log(chalk.green(`Policy deleted for tenant '${tenantId}'`));
        } else {
          console.log(chalk.red(`No policy found for tenant '${tenantId}'`));
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  // ── Claude auth subcommands (RPC: admin/tenant/auth/*) ──────────────
  //
  // Per-tenant binding between the tenant and the credential material used
  // at dispatch. Two modes:
  //   - api_key         -> `secret_ref` is a string secret name
  //                        (becomes `ANTHROPIC_API_KEY` at dispatch).
  //   - subscription_blob -> `secret_ref` is a blob name
  //                        (materialized as a per-session k8s Secret at
  //                         `/root/.claude`).

  const auth = tenant.command("auth").description("Manage per-tenant Claude credential bindings");

  auth
    .command("set")
    .description("Bind a tenant to a Claude credential (api-key secret OR subscription-blob).")
    .argument("<tenant-id>", "Tenant ID (or slug)")
    .option("--api-key <name>", "Bind to a string secret storing ANTHROPIC_API_KEY")
    .option("--subscription-blob <name>", "Bind to a blob secret (the ~/.claude directory)")
    .action(async (tenantId, opts) => {
      try {
        const hasKey = typeof opts.apiKey === "string" && opts.apiKey.length > 0;
        const hasBlob = typeof opts.subscriptionBlob === "string" && opts.subscriptionBlob.length > 0;
        if (hasKey === hasBlob) {
          console.log(chalk.red("Specify exactly one of --api-key or --subscription-blob."));
          process.exitCode = 2;
          return;
        }
        const ark = await getArkClient();
        const kind = hasKey ? "api_key" : "subscription_blob";
        const ref = hasKey ? opts.apiKey : opts.subscriptionBlob;
        const row = await ark.tenantAuthSet(tenantId, kind, ref);
        console.log(chalk.green(`Tenant '${tenantId}' bound to ${row.kind} '${row.secret_ref}'.`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message ?? e}`));
        process.exitCode = 1;
      }
    });

  auth
    .command("show")
    .description("Show the current Claude credential binding for a tenant.")
    .argument("<tenant-id>", "Tenant ID (or slug)")
    .action(async (tenantId) => {
      try {
        const ark = await getArkClient();
        const row = await ark.tenantAuthGet(tenantId);
        if (!row) {
          console.log(chalk.dim(`No Claude auth binding for tenant '${tenantId}'.`));
          return;
        }
        console.log(chalk.bold(`Claude auth for tenant '${row.tenant_id}'`));
        console.log(`  Kind:       ${row.kind}`);
        console.log(`  Secret ref: ${row.secret_ref}`);
        console.log(`  Updated:    ${row.updated_at}`);
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message ?? e}`));
        process.exitCode = 1;
      }
    });

  auth
    .command("clear")
    .description("Remove the Claude credential binding for a tenant.")
    .argument("<tenant-id>", "Tenant ID (or slug)")
    .action(async (tenantId) => {
      try {
        const ark = await getArkClient();
        const ok = await ark.tenantAuthClear(tenantId);
        if (ok) console.log(chalk.green(`Cleared Claude auth for tenant '${tenantId}'.`));
        else console.log(chalk.yellow(`No binding to clear for tenant '${tenantId}'.`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message ?? e}`));
        process.exitCode = 1;
      }
    });
}
