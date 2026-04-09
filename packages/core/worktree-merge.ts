import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { getApp } from "./app.js";
import type { Session } from "../types/index.js";

export async function mergeChildBranches(
  parentId: string,
  children: Session[],
): Promise<{ merged: string[]; conflicts: string[] }> {
  const parent = getApp().sessions.get(parentId);
  if (!parent?.workdir) return { merged: [], conflicts: [] };

  const parentWorktree = `${process.env.HOME}/.ark/worktrees/${parentId}`;
  if (!existsSync(parentWorktree)) return { merged: [], conflicts: [] };

  const merged: string[] = [];
  const conflicts: string[] = [];

  for (const child of children) {
    if (child.status === "failed") continue;

    const childWorktree = `${process.env.HOME}/.ark/worktrees/${child.id}`;
    if (!existsSync(childWorktree)) continue;

    try {
      const branch = execFileSync(
        "git", ["-C", childWorktree, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf-8" },
      ).trim();
      if (!branch || branch === "HEAD") continue;

      execFileSync(
        "git", ["-C", parentWorktree, "merge", "--no-edit", branch],
        { encoding: "utf-8", stdio: "pipe" },
      );
      merged.push(child.id);
    } catch (e: any) {
      const msg = (e.message ?? "") + (e.stderr ?? "");
      if (msg.includes("CONFLICT")) {
        try {
          execFileSync("git", ["-C", parentWorktree, "merge", "--abort"], { stdio: "pipe" });
        } catch {}
        conflicts.push(child.id);
      }
    }
  }

  if (conflicts.length > 0) {
    getApp().events.log(parentId, "merge_conflict", {
      actor: "system",
      data: { merged, conflicts },
    });
    getApp().sessions.update(parentId, { status: "waiting" });
  }

  return { merged, conflicts };
}
