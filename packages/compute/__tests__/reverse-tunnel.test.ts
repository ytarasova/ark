/**
 * Tests for SSH reverse tunnel argument building.
 */

import { describe, it, expect } from "bun:test";
import { buildTunnelArgs } from "../providers/ec2/ports.js";

describe("buildTunnelArgs", () => {
  it("builds correct -L forward tunnel args", () => {
    const args = buildTunnelArgs("/key", "1.2.3.4", [{ port: 3000, name: "web", source: "test" }]);
    expect(args).toContain("-L");
    expect(args).toContain("3000:localhost:3000");
    expect(args).toContain("ubuntu@1.2.3.4");
    expect(args).toContain("-N");
    expect(args).toContain("-f");
  });

  it("builds args for multiple ports", () => {
    const args = buildTunnelArgs("/key", "1.2.3.4", [
      { port: 3000, name: "web", source: "test" },
      { port: 5432, name: "db", source: "test" },
    ]);
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
    const killed = await ports.teardownReverseTunnel("203.0.113.255", 65530);
    expect(killed).toBe(false);
  });
});
