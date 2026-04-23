/**
 * CLI commands for team + membership management inside a tenant.
 *
 * ark team list --tenant <id>
 * ark team create <slug> --tenant <id> --name "..."
 * ark team delete <id>
 * ark team members list <team>
 * ark team members add <team> <userEmail> --role member
 * ark team members remove <team> <userEmail>
 * ark team members set-role <team> <userEmail> <role>
 *
 * Every subcommand dispatches via ArkClient against admin/team/*.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../app-client.js";
import type { ArkClient } from "../../protocol/client.js";
import { runAction } from "./_shared.js";

type MembershipRole = "owner" | "admin" | "member" | "viewer";

async function resolveTenantId(ark: ArkClient, idOrSlug: string): Promise<string> {
  const list = await ark.adminTenantList();
  const match = list.find((t) => t.id === idOrSlug || t.slug === idOrSlug);
  if (!match) throw new Error(`Tenant '${idOrSlug}' not found`);
  return match.id;
}

export function registerTeamCommands(program: Command) {
  const team = program.command("team").description("Manage teams + memberships");

  team
    .command("list")
    .description("List teams in a tenant")
    .requiredOption("--tenant <id>", "Tenant id or slug")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      await runAction("team list", async () => {
        const ark = await getArkClient();
        const tenantId = await resolveTenantId(ark, opts.tenant);
        const teams = await ark.adminTeamList(tenantId);
        if (opts.json) {
          console.log(JSON.stringify(teams, null, 2));
          return;
        }
        if (!teams.length) {
          console.log(chalk.dim(`No teams in tenant '${opts.tenant}'.`));
          return;
        }
        console.log(`  ${"ID".padEnd(22)} ${"SLUG".padEnd(18)} ${"NAME".padEnd(24)} DESCRIPTION`);
        for (const t of teams) {
          console.log(`  ${t.id.padEnd(22)} ${t.slug.padEnd(18)} ${t.name.padEnd(24)} ${t.description ?? ""}`);
        }
      });
    });

  team
    .command("create")
    .description("Create a team inside a tenant")
    .argument("<slug>", "Kebab-case slug (unique within tenant)")
    .requiredOption("--tenant <id>", "Tenant id or slug")
    .option("--name <name>", "Human-readable name (defaults to slug)")
    .option("--description <text>", "Description")
    .option("--json", "Output raw JSON")
    .action(async (slug, opts) => {
      await runAction("team create", async () => {
        const ark = await getArkClient();
        const tenantId = await resolveTenantId(ark, opts.tenant);
        const t = await ark.adminTeamCreate({
          tenant_id: tenantId,
          slug,
          name: opts.name ?? slug,
          description: opts.description ?? null,
        });
        if (opts.json) console.log(JSON.stringify(t, null, 2));
        else console.log(chalk.green(`Team created: ${t.id} (slug=${t.slug}) in tenant '${tenantId}'`));
      });
    });

  team
    .command("update")
    .description("Update a team's slug / name / description")
    .argument("<id>", "Team id")
    .option("--slug <slug>", "New slug")
    .option("--name <name>", "New name")
    .option("--description <text>", "New description")
    .action(async (id, opts) => {
      await runAction("team update", async () => {
        const ark = await getArkClient();
        const t = await ark.adminTeamUpdate({
          id,
          ...(opts.slug ? { slug: opts.slug } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
        });
        if (!t) console.log(chalk.red(`Team '${id}' not found`));
        else console.log(chalk.green(`Team updated: ${t.id}`));
      });
    });

  team
    .command("delete")
    .description("Delete a team (cascades memberships)")
    .argument("<id>", "Team id")
    .action(async (id) => {
      await runAction("team delete", async () => {
        const ark = await getArkClient();
        const ok = await ark.adminTeamDelete(id);
        console.log(ok ? chalk.green(`Team deleted: ${id}`) : chalk.red("Delete failed"));
      });
    });

  // ── Members sub-namespace ─────────────────────────────────────────────

  const members = team.command("members").description("Manage team memberships");

  members
    .command("list")
    .description("List members of a team")
    .argument("<team>", "Team id")
    .option("--json", "Output raw JSON")
    .action(async (teamId, opts) => {
      await runAction("team members list", async () => {
        const ark = await getArkClient();
        const rows = await ark.adminTeamMembersList(teamId);
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (!rows.length) {
          console.log(chalk.dim(`No members in team '${teamId}'.`));
          return;
        }
        console.log(`  ${"EMAIL".padEnd(32)} ${"ROLE".padEnd(10)} ADDED`);
        for (const m of rows) {
          console.log(`  ${m.email.padEnd(32)} ${m.role.padEnd(10)} ${m.created_at}`);
        }
      });
    });

  members
    .command("add")
    .description("Add a user to a team (creates the user if email is new)")
    .argument("<team>", "Team id")
    .argument("<userEmail>", "User email")
    .option("--role <role>", "owner | admin | member | viewer", "member")
    .action(async (teamId, userEmail, opts) => {
      await runAction("team members add", async () => {
        const ark = await getArkClient();
        const m = await ark.adminTeamMembersAdd({
          team_id: teamId,
          email: userEmail,
          role: opts.role as MembershipRole,
        });
        console.log(chalk.green(`Added '${userEmail}' as ${m.role} to team '${teamId}'`));
      });
    });

  members
    .command("remove")
    .description("Remove a user from a team")
    .argument("<team>", "Team id")
    .argument("<userEmail>", "User email")
    .action(async (teamId, userEmail) => {
      await runAction("team members remove", async () => {
        const ark = await getArkClient();
        const ok = await ark.adminTeamMembersRemove({ team_id: teamId, email: userEmail });
        console.log(ok ? chalk.green(`Removed '${userEmail}' from team '${teamId}'`) : chalk.red("Not a member"));
      });
    });

  members
    .command("set-role")
    .description("Change a member's role")
    .argument("<team>", "Team id")
    .argument("<userEmail>", "User email")
    .argument("<role>", "owner | admin | member | viewer")
    .action(async (teamId, userEmail, role) => {
      await runAction("team members set-role", async () => {
        const ark = await getArkClient();
        const m = await ark.adminTeamMembersSetRole({
          team_id: teamId,
          email: userEmail,
          role: role as MembershipRole,
        });
        if (!m) console.log(chalk.red("Membership not found"));
        else console.log(chalk.green(`Updated '${userEmail}' to ${m.role} in team '${teamId}'`));
      });
    });
}
