/**
 * Playwright globalTeardown -- reap orphaned `ark web` processes.
 *
 * Belt-and-suspenders behind the per-worker reap hooks + ARK_WATCH_PARENT
 * watchdog. If the harness somehow gets SIGKILLed AND the child somehow
 * misses the ppid change (bug, race, exotic platform), the next run's
 * globalTeardown sweeps up the wreckage.
 *
 * We only kill processes whose PPID is 1 (reparented to init/launchd --
 * i.e. definitively orphaned), never live children of other workers.
 */

import { execFileSync } from "node:child_process";

const CMD_PATTERN = /bun.*packages\/cli\/index\.ts\s+web/;

function listOrphanPids(): number[] {
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "pid=,ppid=,command=", "-ax"], { encoding: "utf8" });
  } catch {
    return [];
  }

  const orphans: number[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "<pid> <ppid> <command...>" -- split on whitespace, first two are numeric
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[3];
    if (ppid !== 1) continue;
    if (!CMD_PATTERN.test(command)) continue;
    if (pid === process.pid) continue;
    orphans.push(pid);
  }
  return orphans;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export default async function globalTeardown(): Promise<void> {
  const orphans = listOrphanPids();
  if (orphans.length === 0) return;

  console.warn(`[globalTeardown] Killing ${orphans.length} orphan ark web process(es): ${orphans.join(", ")}`);

  for (const pid of orphans) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  await new Promise((r) => setTimeout(r, 500));

  for (const pid of orphans) {
    if (!alive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
