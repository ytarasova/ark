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
 */

import type { Command } from "commander";
import chalk from "chalk";
import { TeamManager, TenantManager, UserManager, type MembershipRole } from "../../core/auth/index.js";
import type { AppContext } from "../../core/app.js";

async function resolveTenantId(app: AppContext, idOrSlug: string): Promise<string> {
  const tm = new TenantManager(app.db);
  const t = await tm.get(idOrSlug);
  if (!t) throw new Error(`Tenant '${idOrSlug}' not found`);
  return t.id;
}

async function resolveUserByEmail(app: AppContext, email: string): Promise<string> {
  const um = new UserManager(app.db);
  const u = await um.upsertByEmail({ email });
  return u.id;
}

export function registerTeamCommands(program: Command, app: AppContext) {
  const team = program.command("team").description("Manage teams + memberships");

  team
    .command("list")
    .description("List teams in a tenant")
    .requiredOption("--tenant <id>", "Tenant id or slug")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const tenantId = await resolveTenantId(app, opts.tenant);
        const teams = await new TeamManager(app.db).listByTenant(tenantId);
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
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
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
      try {
        const tenantId = await resolveTenantId(app, opts.tenant);
        const tm = new TeamManager(app.db);
        const t = await tm.create({
          tenant_id: tenantId,
          slug,
          name: opts.name ?? slug,
          description: opts.description ?? null,
        });
        if (opts.json) console.log(JSON.stringify(t, null, 2));
        else console.log(chalk.green(`Team created: ${t.id} (slug=${t.slug}) in tenant '${tenantId}'`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  team
    .command("update")
    .description("Update a team's slug / name / description")
    .argument("<id>", "Team id")
    .option("--slug <slug>", "New slug")
    .option("--name <name>", "New name")
    .option("--description <text>", "New description")
    .action(async (id, opts) => {
      try {
        const tm = new TeamManager(app.db);
        const patch: Record<string, any> = {};
        if (opts.slug) patch.slug = opts.slug;
        if (opts.name) patch.name = opts.name;
        if (opts.description !== undefined) patch.description = opts.description;
        const t = await tm.update(id, patch);
        if (!t) console.log(chalk.red(`Team '${id}' not found`));
        else console.log(chalk.green(`Team updated: ${t.id}`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  team
    .command("delete")
    .description("Delete a team (cascades memberships)")
    .argument("<id>", "Team id")
    .action(async (id) => {
      try {
        const ok = await new TeamManager(app.db).delete(id);
        console.log(ok ? chalk.green(`Team deleted: ${id}`) : chalk.red("Delete failed"));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  // ── Members sub-namespace ─────────────────────────────────────────────

  const members = team.command("members").description("Manage team memberships");

  members
    .command("list")
    .description("List members of a team")
    .argument("<team>", "Team id")
    .option("--json", "Output raw JSON")
    .action(async (teamId, opts) => {
      try {
        const rows = await new TeamManager(app.db).listMembers(teamId);
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
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  members
    .command("add")
    .description("Add a user to a team (creates the user if email is new)")
    .argument("<team>", "Team id")
    .argument("<userEmail>", "User email")
    .option("--role <role>", "owner | admin | member | viewer", "member")
    .action(async (teamId, userEmail, opts) => {
      try {
        const userId = await resolveUserByEmail(app, userEmail);
        const m = await new TeamManager(app.db).addMember(teamId, userId, opts.role as MembershipRole);
        console.log(chalk.green(`Added '${userEmail}' as ${m.role} to team '${teamId}'`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  members
    .command("remove")
    .description("Remove a user from a team")
    .argument("<team>", "Team id")
    .argument("<userEmail>", "User email")
    .action(async (teamId, userEmail) => {
      try {
        const um = new UserManager(app.db);
        const user = await um.get(userEmail);
        if (!user) {
          console.log(chalk.red(`User '${userEmail}' not found`));
          return;
        }
        const ok = await new TeamManager(app.db).removeMember(teamId, user.id);
        console.log(ok ? chalk.green(`Removed '${userEmail}' from team '${teamId}'`) : chalk.red("Not a member"));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });

  members
    .command("set-role")
    .description("Change a member's role")
    .argument("<team>", "Team id")
    .argument("<userEmail>", "User email")
    .argument("<role>", "owner | admin | member | viewer")
    .action(async (teamId, userEmail, role) => {
      try {
        const um = new UserManager(app.db);
        const user = await um.get(userEmail);
        if (!user) {
          console.log(chalk.red(`User '${userEmail}' not found`));
          return;
        }
        const m = await new TeamManager(app.db).setRole(teamId, user.id, role as MembershipRole);
        if (!m) console.log(chalk.red("Membership not found"));
        else console.log(chalk.green(`Updated '${userEmail}' to ${m.role} in team '${teamId}'`));
      } catch (e: any) {
        console.log(chalk.red(`Failed: ${e.message}`));
      }
    });
}
