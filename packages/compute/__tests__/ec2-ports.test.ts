import { describe, expect, test } from "bun:test";
import { buildTunnelArgs, setupTunnels, teardownTunnels, probeRemotePorts } from "../providers/ec2/ports.js";
import type { PortDecl } from "../types.js";

const KEY = "/tmp/test-key";
const INSTANCE_ID = "i-0abc";
const SSM = { region: "us-east-1" };

const ports: PortDecl[] = [
  { port: 8080, name: "http", source: "arc.json" },
  { port: 3000, name: "dev", source: "arc.json" },
];

describe("buildTunnelArgs", () => {
  test("includes -N and -f flags", () => {
    const args = buildTunnelArgs(KEY, INSTANCE_ID, ports, SSM);
    expect(args).toContain("-N");
    expect(args).toContain("-f");
  });

  test("includes -L for each port", () => {
    const args = buildTunnelArgs(KEY, INSTANCE_ID, ports, SSM);
    const lArgs = args.filter((a) => a.startsWith("8080:") || a.startsWith("3000:"));
    expect(lArgs).toContain("8080:localhost:8080");
    expect(lArgs).toContain("3000:localhost:3000");
  });

  test("with empty ports array still produces valid SSH args", () => {
    const args = buildTunnelArgs(KEY, INSTANCE_ID, [], SSM);
    expect(args[0]).toBe("ssh");
    expect(args).toContain("-i");
    expect(args).toContain("-N");
    expect(args).toContain("-f");
    expect(args[args.length - 1]).toBe(`ubuntu@${INSTANCE_ID}`);
    // No -L flags should be present
    expect(args).not.toContain("-L");
  });

  test("targets ubuntu@<instance_id> with SSM ProxyCommand", () => {
    const args = buildTunnelArgs(KEY, INSTANCE_ID, ports, SSM);
    expect(args[args.length - 1]).toBe(`ubuntu@${INSTANCE_ID}`);
    expect(args.some((a) => a.startsWith("ProxyCommand=aws ssm start-session"))).toBe(true);
  });
});

describe("setupTunnels", () => {
  test("is a function", () => {
    expect(typeof setupTunnels).toBe("function");
  });
});

describe("teardownTunnels", () => {
  test("is a function", () => {
    expect(typeof teardownTunnels).toBe("function");
  });
});

describe("probeRemotePorts", () => {
  test("is a function", () => {
    expect(typeof probeRemotePorts).toBe("function");
  });
});
