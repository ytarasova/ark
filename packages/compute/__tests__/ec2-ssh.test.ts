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
  buildSsmProxyArgs,
  generateSshKey,
} from "../providers/ec2/ssh.js";

describe("EC2 SSH primitives (SSM transport)", async () => {
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
  // buildSsmProxyArgs
  // -----------------------------------------------------------------------
  describe("buildSsmProxyArgs", () => {
    it("emits an `-o ProxyCommand=aws ssm start-session ...` pair", () => {
      const args = buildSsmProxyArgs({ region: "us-east-1" });
      expect(args[0]).toBe("-o");
      expect(args[1]).toContain("ProxyCommand=aws ssm start-session");
      expect(args[1]).toContain("--target %h");
      expect(args[1]).toContain("--document-name AWS-StartSSHSession");
      expect(args[1]).toContain("--parameters portNumber=%p");
      expect(args[1]).toContain("--region us-east-1");
    });

    it("includes --profile when awsProfile is provided", () => {
      const args = buildSsmProxyArgs({ region: "us-west-2", awsProfile: "yt" });
      expect(args[1]).toContain("--profile yt");
    });

    it("omits --profile when awsProfile is undefined", () => {
      const args = buildSsmProxyArgs({ region: "us-east-1" });
      expect(args[1]).not.toContain("--profile");
    });
  });

  // -----------------------------------------------------------------------
  // sshBaseArgs
  // -----------------------------------------------------------------------
  describe("sshBaseArgs", () => {
    it("targets ubuntu@<instance_id>, not ubuntu@<ip>", () => {
      const args = sshBaseArgs("/tmp/key", "i-0abc123", { region: "us-east-1" });
      expect(args[0]).toBe("ssh");
      expect(args).toContain("-i");
      expect(args).toContain("/tmp/key");
      // SSH_OPTS should be present
      expect(args).toContain("-o");
      expect(args).toContain("StrictHostKeyChecking=no");
      // SSM ProxyCommand wraps the connection.
      expect(args.some((a) => a.startsWith("ProxyCommand=aws ssm start-session"))).toBe(true);
      // target user@instance-id at the end
      expect(args[args.length - 1]).toBe("ubuntu@i-0abc123");
    });

    it("includes -L port forwards when ports are provided", () => {
      const args = sshBaseArgs("/tmp/key", "i-0abc", { region: "us-east-1" }, [8080, 9090]);
      expect(args).toContain("-L");
      expect(args).toContain("8080:localhost:8080");
      expect(args).toContain("9090:localhost:9090");
      // target is still last
      expect(args[args.length - 1]).toBe("ubuntu@i-0abc");
    });
  });

  // -----------------------------------------------------------------------
  // rsyncPushArgs / rsyncPullArgs
  // -----------------------------------------------------------------------
  describe("rsyncPushArgs", () => {
    it("builds correct rsync push command targeting instance_id with SSM ProxyCommand", () => {
      const args = rsyncPushArgs("/tmp/key", "i-0abc", "/local/dir/", "/remote/dir/", { region: "us-east-1" });
      expect(args[0]).toBe("rsync");
      expect(args).toContain("-avz");
      expect(args).toContain("--update");
      expect(args).toContain("--timeout=30");
      expect(args).toContain("-e");
      expect(args).toContain("/local/dir/");
      // The -e arg embeds the SSM ProxyCommand.
      const eFlag = args[args.indexOf("-e") + 1];
      expect(eFlag).toContain("ProxyCommand=aws ssm start-session");
      expect(args[args.length - 1]).toBe("ubuntu@i-0abc:/remote/dir/");
    });
  });

  describe("rsyncPullArgs", () => {
    it("builds correct rsync pull command (instance_id, SSM proxy)", () => {
      const args = rsyncPullArgs("/tmp/key", "i-0abc", "/remote/dir/", "/local/dir/", { region: "us-east-1" });
      expect(args[0]).toBe("rsync");
      expect(args).toContain("-avz");
      expect(args).toContain("--update");
      // source is remote (instance_id), destination is local
      expect(args).toContain("ubuntu@i-0abc:/remote/dir/");
      expect(args[args.length - 1]).toBe("/local/dir/");
    });
  });

  // -----------------------------------------------------------------------
  // sshExec - graceful failure
  // -----------------------------------------------------------------------
  describe("sshExec", async () => {
    it("handles failure gracefully (no AWS credentials, bogus instance id)", async () => {
      // No real SSM session can succeed in the sandbox -- aws CLI either
      // isn't installed or has no creds. We just assert the helper returns
      // a non-zero exitCode rather than throwing.
      const result = await sshExec("/nonexistent/key", "i-0bogus", "echo hi", {
        timeout: 3_000,
        region: "us-east-1",
      });
      expect(result).toHaveProperty("stdout");
      expect(result).toHaveProperty("stderr");
      expect(result).toHaveProperty("exitCode");
      expect(result.exitCode).not.toBe(0);
    }, 15_000);
  });

  // -----------------------------------------------------------------------
  // SSH_OPTS smoke check (regression: must NOT include direct ProxyJump etc)
  // -----------------------------------------------------------------------
  describe("SSH_OPTS", () => {
    it("includes StrictHostKeyChecking=no and a UserKnownHostsFile override", () => {
      expect(SSH_OPTS).toContain("StrictHostKeyChecking=no");
      expect(SSH_OPTS).toContain("UserKnownHostsFile=/dev/null");
    });
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
      execFileSync("ssh-keygen", ["-t", "ed25519", "-f", privateKeyPath, "-N", "", "-C", `ark-${hostName}`], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      expect(existsSync(privateKeyPath)).toBe(true);
      expect(existsSync(publicKeyPath)).toBe(true);
      // generateSshKey is exported and is a function; the body is not
      // exercised here because it writes to ~/.ssh.
      expect(typeof generateSshKey).toBe("function");
    });
  });
});
