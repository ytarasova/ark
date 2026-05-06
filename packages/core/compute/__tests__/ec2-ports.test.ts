import { describe, expect, test } from "bun:test";
import {
  setupTunnels,
  teardownTunnels,
  probeRemotePorts,
  setupForwardTunnel,
  teardownForwardTunnel,
} from "../ec2/ports.js";

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

describe("setupForwardTunnel", () => {
  test("is a function", () => {
    expect(typeof setupForwardTunnel).toBe("function");
  });
});

describe("teardownForwardTunnel", () => {
  test("is a function", () => {
    expect(typeof teardownForwardTunnel).toBe("function");
  });
});

describe("probeRemotePorts", () => {
  test("is a function", () => {
    expect(typeof probeRemotePorts).toBe("function");
  });
});
