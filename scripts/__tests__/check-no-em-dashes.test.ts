import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const SCRIPT = join(import.meta.dir, "..", "check-no-em-dashes.sh");

describe("check-no-em-dashes.sh", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "emdash-"));
    chmodSync(SCRIPT, 0o755);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 when no em dashes present", () => {
    writeFileSync(join(dir, "clean.md"), "hello -- world\n");
    const r = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("exits nonzero when an em dash is present", () => {
    writeFileSync(join(dir, "dirty.md"), "hello \u2014 world\n");
    const r = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });
});
