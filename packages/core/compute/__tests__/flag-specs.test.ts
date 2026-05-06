/**
 * ProviderFlagSpec registry tests.
 *
 * Each spec is a CLI-layer adapter that turns raw Commander opts into a
 * config payload + a post-create display summary. The tests below lock the
 * shape of every shipping provider so a future contributor adding a spec
 * doesn't accidentally regress the existing ones.
 */

import { describe, it, expect } from "bun:test";
import { allFlagSpecs, getFlagSpec, flagSpecRegistry } from "../flag-specs/index.js";
import { dockerFlagSpec } from "../flag-specs/docker.js";
import { ec2FlagSpec } from "../flag-specs/ec2.js";
import { k8sFlagSpec } from "../flag-specs/k8s.js";
import { localFlagSpec } from "../flag-specs/local.js";
import { firecrackerFlagSpec } from "../flag-specs/firecracker.js";

describe("docker flag spec", () => {
  it("configFromFlags defaults image when empty", () => {
    const cfg = dockerFlagSpec.configFromFlags({});
    expect(cfg).toEqual({ image: "ubuntu:22.04" });
  });

  it("configFromFlags honors provided image + devcontainer + volumes", () => {
    const cfg = dockerFlagSpec.configFromFlags({
      image: "node:20",
      devcontainer: true,
      volume: ["/host:/guest", "/data:/data"],
    });
    expect(cfg).toEqual({
      image: "node:20",
      devcontainer: true,
      volumes: ["/host:/guest", "/data:/data"],
    });
  });

  it("configFromFlags drops empty volume list", () => {
    const cfg = dockerFlagSpec.configFromFlags({ image: "alpine", volume: [] });
    expect(cfg).toEqual({ image: "alpine" });
  });

  it("displaySummary lists image + devcontainer + volumes", () => {
    const lines = dockerFlagSpec.displaySummary({ image: "node:20", devcontainer: true, volumes: ["/a:/a"] }, {});
    expect(lines).toEqual(["  Image:    node:20", "  Devcontainer: yes", "  Volumes:  /a:/a"]);
  });

  it("displaySummary omits missing optional fields", () => {
    const lines = dockerFlagSpec.displaySummary({ image: "ubuntu:22.04" }, {});
    expect(lines).toEqual(["  Image:    ubuntu:22.04"]);
  });
});

describe("ec2 flag spec", () => {
  it("configFromFlags carries size/arch/region + optional aws-profile/subnet/tags", () => {
    const cfg = ec2FlagSpec.configFromFlags({
      size: "m",
      arch: "x64",
      awsRegion: "us-east-1",
      awsProfile: "yt",
      awsSubnetId: "subnet-abc",
      awsTag: ["owner=yana", "env=dev"],
    });
    expect(cfg).toEqual({
      size: "m",
      arch: "x64",
      region: "us-east-1",
      aws_profile: "yt",
      subnet_id: "subnet-abc",
      tags: { owner: "yana", env: "dev" },
    });
  });

  it("configFromFlags tolerates no tags / no optional fields", () => {
    const cfg = ec2FlagSpec.configFromFlags({
      size: "s",
      arch: "arm",
      awsRegion: "eu-west-1",
      awsTag: [],
    });
    expect(cfg).toEqual({ size: "s", arch: "arm", region: "eu-west-1" });
  });

  it("configFromFlags treats missing tag list as empty", () => {
    const cfg = ec2FlagSpec.configFromFlags({ size: "xs", arch: "x64", awsRegion: "us-east-1" });
    expect(cfg.tags).toBeUndefined();
  });

  it("displaySummary resolves size label from INSTANCE_SIZES", () => {
    const lines = ec2FlagSpec.displaySummary(
      { size: "m", arch: "x64", region: "us-east-1" },
      { size: "m", arch: "x64", awsRegion: "us-east-1" },
    );
    expect(lines[0]).toContain("Medium");
    expect(lines[1]).toBe("  Arch:     x64");
    expect(lines[2]).toBe("  Region:   us-east-1");
  });

  it("displaySummary falls back to raw size for unknown tier", () => {
    const lines = ec2FlagSpec.displaySummary(
      { size: "custom", arch: "arm", region: "ap-south-1" },
      { size: "custom", arch: "arm", awsRegion: "ap-south-1" },
    );
    expect(lines[0]).toBe("  Size:     custom");
  });
});

describe("k8s flag spec", () => {
  it("configFromFlags emits only provided fields", () => {
    const cfg = k8sFlagSpec.configFromFlags({
      namespace: "ark",
      image: "ubuntu:22.04",
      kubeconfig: "/tmp/kubeconfig",
      runtimeClass: "kata-fc",
    });
    expect(cfg).toEqual({
      namespace: "ark",
      image: "ubuntu:22.04",
      kubeconfig: "/tmp/kubeconfig",
      runtimeClassName: "kata-fc",
    });
  });

  it("configFromFlags strips blank fields", () => {
    const cfg = k8sFlagSpec.configFromFlags({});
    expect(cfg).toEqual({});
  });

  it("displaySummary shows defaults + runtime/kubeconfig when set", () => {
    const lines = k8sFlagSpec.displaySummary(
      { namespace: "ark", image: "ubuntu:22.04", runtimeClassName: "kata-fc", kubeconfig: "/k.yaml" },
      {},
    );
    expect(lines).toEqual([
      "  Namespace:  ark",
      "  Image:      ubuntu:22.04",
      "  Runtime:    kata-fc",
      "  Kubeconfig: /k.yaml",
    ]);
  });

  it("displaySummary renders no lines when config is empty (no silent defaults)", () => {
    // Upstream intentionally removed default Namespace/Image so a misconfigured
    // compute target fails at create time rather than provisioning into the wrong
    // cluster. See commit 91217e89.
    const lines = k8sFlagSpec.displaySummary({}, {});
    expect(lines).toEqual([]);
  });
});

describe("local flag spec", () => {
  it("has no options", () => {
    expect(localFlagSpec.options).toEqual([]);
  });

  it("configFromFlags always returns empty object", () => {
    expect(localFlagSpec.configFromFlags({ image: "ignored" })).toEqual({});
  });

  it("displaySummary returns empty list", () => {
    expect(localFlagSpec.displaySummary({}, {})).toEqual([]);
  });
});

describe("firecracker flag spec", () => {
  it("has no CLI-exposed knobs today", () => {
    expect(firecrackerFlagSpec.options).toEqual([]);
    expect(firecrackerFlagSpec.configFromFlags({})).toEqual({});
    expect(firecrackerFlagSpec.displaySummary({}, {})).toEqual([]);
  });
});

describe("registry lookup", () => {
  it("getFlagSpec resolves each primary provider key", () => {
    expect(getFlagSpec("local")).toBe(localFlagSpec);
    expect(getFlagSpec("docker")).toBe(dockerFlagSpec);
    expect(getFlagSpec("ec2")).toBe(ec2FlagSpec);
    expect(getFlagSpec("k8s")).toBe(k8sFlagSpec);
    expect(getFlagSpec("firecracker")).toBe(firecrackerFlagSpec);
  });

  it("getFlagSpec treats k8s-kata as an alias of the k8s spec", () => {
    expect(getFlagSpec("k8s-kata")).toBe(k8sFlagSpec);
  });

  it("getFlagSpec returns null for unknown provider", () => {
    expect(getFlagSpec("unknown-provider")).toBeNull();
  });

  it("allFlagSpecs de-duplicates aliases", () => {
    const specs = allFlagSpecs();
    expect(new Set(specs).size).toBe(specs.length);
    // k8s-kata is aliased to k8s, so the spec should only appear once.
    expect(specs.filter((s) => s === k8sFlagSpec).length).toBe(1);
  });

  it("flagSpecRegistry keeps k8s + k8s-kata pointing at the same spec", () => {
    expect(flagSpecRegistry.get("k8s")).toBe(flagSpecRegistry.get("k8s-kata"));
  });
});
