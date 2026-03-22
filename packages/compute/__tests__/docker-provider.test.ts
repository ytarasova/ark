import { describe, it, expect } from "bun:test";
import { DockerProvider } from "../providers/docker/index.js";

const provider = new DockerProvider();
const fakeHost = { name: "docker-test", provider: "docker", status: "running", config: {}, created_at: "", updated_at: "" };

describe("DockerProvider", () => {
  it("has name 'docker'", () => {
    expect(provider.name).toBe("docker");
  });

  it("implements all ComputeProvider methods", () => {
    for (const method of ["provision", "destroy", "start", "stop", "launch", "attach", "getMetrics", "probePorts", "syncEnvironment"]) {
      expect(typeof (provider as any)[method]).toBe("function");
    }
  });

  it("getMetrics returns valid snapshot shape", async () => {
    const snap = await provider.getMetrics(fakeHost);
    expect(snap).toHaveProperty("metrics");
    expect(snap).toHaveProperty("sessions");
    expect(snap).toHaveProperty("processes");
    expect(snap).toHaveProperty("docker");
    expect(Array.isArray(snap.docker)).toBe(true);
  });

  it("probePorts returns status for each port", async () => {
    const result = await provider.probePorts(fakeHost, [{ port: 99999, source: "test" }]);
    expect(result).toHaveLength(1);
    expect(result[0].listening).toBe(false);
  });

  it("syncEnvironment is a no-op (uses mounts)", async () => {
    await provider.syncEnvironment(fakeHost, { direction: "push" });
  });
});
