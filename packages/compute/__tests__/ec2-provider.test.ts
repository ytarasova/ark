import { describe, it, expect } from "bun:test";
import { EC2Provider } from "../providers/ec2/index.js";

const provider = new EC2Provider();

describe("EC2Provider", () => {
  it("has name 'ec2'", () => {
    expect(provider.name).toBe("ec2");
  });

  it("implements all ComputeProvider methods", () => {
    expect(typeof provider.provision).toBe("function");
    expect(typeof provider.destroy).toBe("function");
    expect(typeof provider.start).toBe("function");
    expect(typeof provider.stop).toBe("function");
    expect(typeof provider.launch).toBe("function");
    expect(typeof provider.attach).toBe("function");
    expect(typeof provider.getMetrics).toBe("function");
    expect(typeof provider.probePorts).toBe("function");
    expect(typeof provider.syncEnvironment).toBe("function");
  });

  it("probePorts returns not-listening for host without IP", async () => {
    const host = {
      name: "test",
      provider: "ec2",
      status: "stopped",
      config: {},
      created_at: "",
      updated_at: "",
    };
    const result = await provider.probePorts(host, [
      { port: 3000, source: "test" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].listening).toBe(false);
  });
});
