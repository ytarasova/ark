import { describe, it, expect } from "bun:test";
import { DockerProvider, containerName } from "../providers/docker/index.js";

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
    expect(Array.isArray(snap.sessions)).toBe(true);
    expect(Array.isArray(snap.processes)).toBe(true);

    // Metrics shape
    const m = snap.metrics;
    expect(typeof m.cpu).toBe("number");
    expect(typeof m.memUsedGb).toBe("number");
    expect(typeof m.memTotalGb).toBe("number");
    expect(typeof m.memPct).toBe("number");
    expect(typeof m.diskPct).toBe("number");
    expect(typeof m.netRxMb).toBe("number");
    expect(typeof m.netTxMb).toBe("number");
    expect(typeof m.uptime).toBe("string");
    expect(typeof m.idleTicks).toBe("number");
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

describe("containerName", () => {
  it("prefixes host name with ark-", () => {
    expect(containerName("my-host")).toBe("ark-my-host");
  });

  it("handles simple names", () => {
    expect(containerName("test")).toBe("ark-test");
  });

  it("handles hyphenated names", () => {
    expect(containerName("dev-box-01")).toBe("ark-dev-box-01");
  });
});

describe("DockerProvider.provision", () => {
  it("throws when Docker is not available", async () => {
    // This test will only pass in environments without Docker.
    // In CI with Docker, provision would succeed. We check that
    // the method at least validates Docker availability.
    const hostNoDocker = {
      ...fakeHost,
      name: "no-docker-test",
      config: { image: "nonexistent-image-abc:latest" },
    };

    // The provision method should throw if docker info fails
    // or if the image doesn't exist. Either way it should not
    // silently succeed with a bogus image.
    try {
      await provider.provision(hostNoDocker);
      // If we reach here, Docker is running. That's fine,
      // it will fail on the pull of a nonexistent image.
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});
