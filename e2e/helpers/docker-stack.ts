/**
 * Compose lifecycle for the e2e suite.
 *
 * The Makefile target wraps these calls; they live in TS too so a debug run
 * via `bun e2e/control-plane.test.ts` can self-contain its stack lifecycle.
 *
 * Skips bring-up/tear-down when ARK_E2E_STACK_RUNNING=1 -- useful when an
 * operator already brought up the e2e stack in another terminal and just
 * wants to iterate on the test code without paying the 15s cold-start tax.
 */

const COMPOSE_FILE = ".infra/docker-compose.e2e.yaml";
const PROJECT_NAME = "ark-e2e";

let cachedCli: string[] | null = null;

async function pickComposeCli(): Promise<string[]> {
  if (cachedCli) return cachedCli;
  // Prefer the v2 plugin (`docker compose`); fall back to the standalone
  // `docker-compose` binary which is still common on macOS Docker Desktop
  // installs that haven't migrated to the v2 plugin path.
  const probe = Bun.spawn(["docker", "compose", "version"], { stdout: "ignore", stderr: "ignore" });
  if ((await probe.exited) === 0) {
    cachedCli = ["docker", "compose"];
  } else {
    cachedCli = ["docker-compose"];
  }
  return cachedCli;
}

export async function up(): Promise<void> {
  if (process.env.ARK_E2E_STACK_RUNNING === "1") return;
  const cli = await pickComposeCli();
  const proc = Bun.spawn([...cli, "-f", COMPOSE_FILE, "-p", PROJECT_NAME, "up", "-d", "--wait"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`docker compose up failed (exit ${code})`);
}

export async function down(): Promise<void> {
  if (process.env.ARK_E2E_STACK_RUNNING === "1") return;
  const cli = await pickComposeCli();
  const proc = Bun.spawn([...cli, "-f", COMPOSE_FILE, "-p", PROJECT_NAME, "down", "-v"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}
