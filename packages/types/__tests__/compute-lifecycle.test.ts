import { describe, it, expect } from "bun:test";
import {
  COMPUTE_KIND_LIFECYCLE,
  RUNTIME_KIND_LIFECYCLE,
  effectiveLifecycle,
  type ComputeKindName,
  type RuntimeKindName,
} from "../compute.js";

describe("compute lifecycle classification", () => {
  it("local + ec2 are persistent compute kinds", () => {
    expect(COMPUTE_KIND_LIFECYCLE.local).toBe("persistent");
    expect(COMPUTE_KIND_LIFECYCLE.ec2).toBe("persistent");
  });

  it("k8s, k8s-kata, firecracker are template compute kinds", () => {
    expect(COMPUTE_KIND_LIFECYCLE.k8s).toBe("template");
    expect(COMPUTE_KIND_LIFECYCLE["k8s-kata"]).toBe("template");
    expect(COMPUTE_KIND_LIFECYCLE.firecracker).toBe("template");
  });

  it("direct is the only persistent runtime kind", () => {
    expect(RUNTIME_KIND_LIFECYCLE.direct).toBe("persistent");
    expect(RUNTIME_KIND_LIFECYCLE.docker).toBe("template");
    expect(RUNTIME_KIND_LIFECYCLE.compose).toBe("template");
    expect(RUNTIME_KIND_LIFECYCLE.devcontainer).toBe("template");
    expect(RUNTIME_KIND_LIFECYCLE["firecracker-in-container"]).toBe("template");
  });

  it("effectiveLifecycle: persistent only when both axes are persistent", () => {
    expect(effectiveLifecycle("local", "direct")).toBe("persistent");
    expect(effectiveLifecycle("ec2", "direct")).toBe("persistent");
  });

  it("effectiveLifecycle: template kind always wins", () => {
    expect(effectiveLifecycle("k8s", "direct")).toBe("template");
    expect(effectiveLifecycle("firecracker", "direct")).toBe("template");
    expect(effectiveLifecycle("k8s-kata", "direct")).toBe("template");
  });

  it("effectiveLifecycle: template runtime makes a persistent kind ephemeral", () => {
    expect(effectiveLifecycle("local", "docker")).toBe("template");
    expect(effectiveLifecycle("local", "compose")).toBe("template");
    expect(effectiveLifecycle("local", "devcontainer")).toBe("template");
    expect(effectiveLifecycle("ec2", "docker")).toBe("template");
  });

  it("every ComputeKindName has a lifecycle entry", () => {
    const kinds: ComputeKindName[] = ["local", "firecracker", "ec2", "k8s", "k8s-kata"];
    for (const k of kinds) {
      expect(COMPUTE_KIND_LIFECYCLE[k]).toBeDefined();
    }
  });

  it("every RuntimeKindName has a lifecycle entry", () => {
    const kinds: RuntimeKindName[] = ["direct", "docker", "compose", "devcontainer", "firecracker-in-container"];
    for (const k of kinds) {
      expect(RUNTIME_KIND_LIFECYCLE[k]).toBeDefined();
    }
  });
});
