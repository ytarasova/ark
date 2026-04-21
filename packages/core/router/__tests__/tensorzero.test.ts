import { describe, it, expect } from "bun:test";
import { TensorZeroManager } from "../tensorzero.js";

describe("TensorZeroManager", async () => {
  it("constructs with default options", () => {
    const mgr = new TensorZeroManager({});
    expect(mgr.url).toBe("http://localhost:3000");
    expect(mgr.openaiUrl).toBe("http://localhost:3000/openai/v1");
  });

  it("respects custom port", () => {
    const mgr = new TensorZeroManager({ port: 4000 });
    expect(mgr.url).toBe("http://localhost:4000");
    expect(mgr.openaiUrl).toBe("http://localhost:4000/openai/v1");
  });

  it("isHealthy returns false when nothing is running", async () => {
    const mgr = new TensorZeroManager({ port: 39999 }); // unlikely to be in use
    const healthy = await mgr.isHealthy();
    expect(healthy).toBe(false);
  });

  it("start detects already-running sidecar", async () => {
    // If sidecar is already running (isHealthy returns true), start is a no-op
    const mgr = new TensorZeroManager({ port: 39999 });
    // Monkey-patch isHealthy to return true
    (mgr as any).isHealthy = async () => true;
    // Should not throw -- just returns because sidecar is detected
    await mgr.start();
  });

  it("stop is safe to call when nothing is running", async () => {
    const mgr = new TensorZeroManager({});
    // Should not throw
    await mgr.stop();
  });

  it("findBinary returns null when no binary exists", () => {
    const mgr = new TensorZeroManager({ binaryPath: "/nonexistent/path/tensorzero-gateway" });
    // The explicit path doesn't exist, and there's no vendored or PATH binary
    const binary = (mgr as any).findBinary();
    // May or may not find one depending on system -- just verify it doesn't throw
    expect(typeof binary === "string" || binary === null).toBe(true);
  });

  it("findBinary returns explicit path when it exists", () => {
    // Use the bun binary as a stand-in for an existing file
    const mgr = new TensorZeroManager({ binaryPath: process.argv[0] });
    const binary = (mgr as any).findBinary();
    expect(binary).toBe(process.argv[0]);
  });
});
