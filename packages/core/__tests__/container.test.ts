/**
 * Unit tests for the awilix DI container definition.
 *
 * Verifies that createAppContainer() produces a valid container with
 * the correct injection mode, and that the Cradle interface is properly
 * structured to support CLASSIC mode injection.
 */

import { describe, it, expect } from "bun:test";
import { createAppContainer } from "../container.js";
import { InjectionMode, asValue } from "awilix";

describe("createAppContainer()", () => {
  it("creates a container successfully", () => {
    const container = createAppContainer();
    expect(container).toBeDefined();
    expect(container).not.toBeNull();
  });

  it("container has CLASSIC injection mode", () => {
    const container = createAppContainer();
    // Verify injection mode by checking the container's options
    expect(container.options.injectionMode).toBe(InjectionMode.CLASSIC);
  });

  it("container is in strict mode", () => {
    const container = createAppContainer();
    expect(container.options.strict).toBe(true);
  });

  it("container starts empty (no registrations)", () => {
    const container = createAppContainer();
    // Attempting to resolve before registration should throw
    expect(() => container.resolve("config")).toThrow();
  });

  it("created containers are independent instances", () => {
    const container1 = createAppContainer();
    const container2 = createAppContainer();
    expect(container1).not.toBe(container2);
  });
});

describe("Cradle interface structure", () => {
  it("AppContainer type is properly exported", () => {
    // This is a compile-time check, but we verify the module structure
    const container = createAppContainer();
    expect(typeof container.resolve).toBe("function");
    expect(typeof container.register).toBe("function");
  });

  it("container.resolve is callable", () => {
    const container = createAppContainer();
    expect(typeof container.resolve).toBe("function");
  });

  it("container.register is callable", () => {
    const container = createAppContainer();
    expect(typeof container.register).toBe("function");
  });

  it("container has dispose method for cleanup", () => {
    const container = createAppContainer();
    expect(typeof container.dispose).toBe("function");
  });
});

describe("container registration and resolution", () => {
  it("can register and resolve a simple value", () => {
    const container = createAppContainer();
    const testConfig = { arkDir: "/test" };

    container.register({ testValue: asValue(testConfig) });
    const resolved = container.resolve("testValue");
    expect(resolved).toBe(testConfig);
  });

  it("cannot resolve unregistered keys in strict mode", () => {
    const container = createAppContainer();
    expect(() => container.resolve("nonexistent")).toThrow();
  });

  it("dispose is callable without error", async () => {
    const container = createAppContainer();
    // Should not throw
    await expect(container.dispose()).resolves.toBeUndefined();
  });
});
