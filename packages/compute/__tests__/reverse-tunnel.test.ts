/**
 * Tests for SSH reverse tunnel argument building.
 */

import { describe, it, expect } from "bun:test";
import { buildTunnelArgs } from "../providers/ec2/ports.js";

const SSM = { region: "us-east-1" };

describe("buildTunnelArgs", () => {
  it("builds correct -L forward tunnel args (instance_id + SSM ProxyCommand)", () => {
    const args = buildTunnelArgs("/key", "i-0abc", [{ port: 3000, name: "web", source: "test" }], SSM);
    expect(args).toContain("-L");
    expect(args).toContain("3000:localhost:3000");
    expect(args).toContain("ubuntu@i-0abc");
    expect(args).toContain("-N");
    expect(args).toContain("-f");
    expect(args.some((a) => a.startsWith("ProxyCommand=aws ssm start-session"))).toBe(true);
  });

  it("builds args for multiple ports", () => {
    const args = buildTunnelArgs(
      "/key",
      "i-0abc",
      [
        { port: 3000, name: "web", source: "test" },
        { port: 5432, name: "db", source: "test" },
      ],
      SSM,
    );
    const lFlags = args.filter((a) => a === "-L");
    expect(lFlags.length).toBe(2);
    expect(args).toContain("3000:localhost:3000");
    expect(args).toContain("5432:localhost:5432");
  });
});

// Note: setupReverseTunnel spawns a real SSH process so we test
// the argument construction pattern rather than the spawn itself.
// The function follows the same pattern as setupTunnels (which is
// already validated in production) but with -R instead of -L.
describe("setupReverseTunnel", async () => {
  it("is exported from ports module", async () => {
    const ports = await import("../providers/ec2/ports.js");
    expect(typeof ports.setupReverseTunnel).toBe("function");
  });

  it("teardownReverseTunnel is exported and idempotent on a missing tunnel", async () => {
    const ports = await import("../providers/ec2/ports.js");
    expect(typeof ports.teardownReverseTunnel).toBe("function");
    // Calling teardown for a non-existent tunnel returns false (nothing to
    // kill) rather than throwing -- callers shouldn't have to guard this.
    const killed = await ports.teardownReverseTunnel("i-bogus-target", 65530);
    expect(killed).toBe(false);
  });
});

// Forward tunnel for arkd HTTP. Same shape as setupReverseTunnel but with
// `-L <localPort>:localhost:<remotePort>` so the conductor can reach the
// remote arkd through SSM. We don't spawn real SSH; we exercise the export
// surface and the teardown idempotency contract.
describe("setupForwardTunnel", async () => {
  it("is exported from ports module", async () => {
    const ports = await import("../providers/ec2/ports.js");
    expect(typeof ports.setupForwardTunnel).toBe("function");
  });

  it("teardownForwardTunnel is exported and idempotent on a missing tunnel", async () => {
    const ports = await import("../providers/ec2/ports.js");
    expect(typeof ports.teardownForwardTunnel).toBe("function");
    const killed = await ports.teardownForwardTunnel("i-bogus-target", 65530);
    expect(killed).toBe(false);
  });
});
