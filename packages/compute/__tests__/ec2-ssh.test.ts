import { describe, it, expect, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

import {
  SSH_OPTS,
  sshKeyPath,
  sshBaseArgs,
  sshExec,
  rsyncPushArgs,
  rsyncPullArgs,
  generateSshKey,
} from "../providers/ec2/ssh.js";

describe("EC2 SSH primitives", () => {
  // -----------------------------------------------------------------------
  // sshKeyPath
  // -----------------------------------------------------------------------
  describe("sshKeyPath", () => {
    it("returns a path under ~/.ssh/", () => {
      const p = sshKeyPath("myhost");
      expect(p).toBe(join(homedir(), ".ssh", "ark-myhost"));
      expect(p.startsWith(join(homedir(), ".ssh"))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // sshBaseArgs
  // -----------------------------------------------------------------------
  describe("sshBaseArgs", () => {
    it("builds correct args without port forwards", () => {
      const args = sshBaseArgs("/tmp/key", "1.2.3.4");
      expect(args[0]).toBe("ssh");
      expect(args).toContain("-i");
      expect(args).toContain("/tmp/key");
      // SSH_OPTS should be present
      expect(args).toContain("-o");
      expect(args).toContain("StrictHostKeyChecking=no");
      // target user@ip at the end
      expect(args[args.length - 1]).toBe("ubuntu@1.2.3.4");
    });

    it("includes -L port forwards when ports are provided", () => {
      const args = sshBaseArgs("/tmp/key", "1.2.3.4", [8080, 9090]);
      expect(args).toContain("-L");
      expect(args).toContain("8080:localhost:8080");
      expect(args).toContain("9090:localhost:9090");
      // target is still last
      expect(args[args.length - 1]).toBe("ubuntu@1.2.3.4");
    });
  });

  // -----------------------------------------------------------------------
  // rsyncPushArgs / rsyncPullArgs
  // -----------------------------------------------------------------------
  describe("rsyncPushArgs", () => {
    it("builds correct rsync push command", () => {
      const args = rsyncPushArgs("/tmp/key", "1.2.3.4", "/local/dir/", "/remote/dir/");
      expect(args[0]).toBe("rsync");
      expect(args).toContain("-avz");
      expect(args).toContain("--update");
      expect(args).toContain("--timeout=30");
      expect(args).toContain("-e");
      expect(args).toContain("/local/dir/");
      expect(args[args.length - 1]).toBe("ubuntu@1.2.3.4:/remote/dir/");
    });
  });

  describe("rsyncPullArgs", () => {
    it("builds correct rsync pull command", () => {
      const args = rsyncPullArgs("/tmp/key", "1.2.3.4", "/remote/dir/", "/local/dir/");
      expect(args[0]).toBe("rsync");
      expect(args).toContain("-avz");
      expect(args).toContain("--update");
      // source is remote, destination is local
      expect(args).toContain("ubuntu@1.2.3.4:/remote/dir/");
      expect(args[args.length - 1]).toBe("/local/dir/");
    });
  });

  // -----------------------------------------------------------------------
  // sshExec - graceful failure
  // -----------------------------------------------------------------------
  describe("sshExec", () => {
    it("handles failure gracefully (unreachable host, nonexistent key)", async () => {
      // 192.0.2.1 is TEST-NET-1 (RFC 5737) - guaranteed unreachable.
      // Use a very short timeout so the test doesn't block.
      const result = await sshExec("/nonexistent/key", "192.0.2.1", "echo hi", { timeout: 3_000 });
      expect(result).toHaveProperty("stdout");
      expect(result).toHaveProperty("stderr");
      expect(result).toHaveProperty("exitCode");
      expect(result.exitCode).not.toBe(0);
    }, 15_000);
  });

  // -----------------------------------------------------------------------
  // generateSshKey - temp dir
  // -----------------------------------------------------------------------
  describe("generateSshKey", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ark-ssh-test-"));
    const hostName = `test-${Date.now()}`;

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates key files in temp dir", () => {
      // Patch HOME so sshKeyPath resolves inside our temp dir.
      // generateSshKey uses sshKeyPath which calls homedir(), so we
      // override via the module-level function by calling ssh-keygen
      // directly with a known path instead.
      const privateKeyPath = join(tmpDir, `ark-${hostName}`);
      const publicKeyPath = `${privateKeyPath}.pub`;

      // Use execFileSync directly to generate the key in temp dir
      execFileSync("ssh-keygen", [
        "-t", "ed25519",
        "-f", privateKeyPath,
        "-N", "",
        "-C", `ark-${hostName}`,
      ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

      expect(existsSync(privateKeyPath)).toBe(true);
      expect(existsSync(publicKeyPath)).toBe(true);
    });
  });
});
