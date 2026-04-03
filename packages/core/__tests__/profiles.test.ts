import { describe, it, expect } from "bun:test";
import { listProfiles, createProfile, deleteProfile, getActiveProfile, setActiveProfile, profileGroupPrefix } from "../profiles.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("profiles", () => {
  it("listProfiles returns at least default", () => {
    const profiles = listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    expect(profiles.find(p => p.name === "default")).toBeDefined();
  });

  it("createProfile adds a new profile", () => {
    createProfile("work", "Work profile");
    const profiles = listProfiles();
    expect(profiles.find(p => p.name === "work")).toBeDefined();
  });

  it("createProfile rejects duplicates", () => {
    createProfile("dup-test");
    expect(() => createProfile("dup-test")).toThrow("already exists");
  });

  it("deleteProfile removes a profile", () => {
    createProfile("temp");
    expect(deleteProfile("temp")).toBe(true);
    expect(listProfiles().find(p => p.name === "temp")).toBeUndefined();
  });

  it("deleteProfile rejects default", () => {
    expect(() => deleteProfile("default")).toThrow("Cannot delete");
  });

  it("deleteProfile returns false for missing", () => {
    expect(deleteProfile("nonexistent")).toBe(false);
  });

  it("active profile defaults to 'default'", () => {
    expect(getActiveProfile()).toBe("default");
  });

  it("setActiveProfile changes the active profile", () => {
    setActiveProfile("work");
    expect(getActiveProfile()).toBe("work");
    setActiveProfile("default"); // reset
  });

  it("profileGroupPrefix is empty for default", () => {
    setActiveProfile("default");
    expect(profileGroupPrefix()).toBe("");
  });

  it("profileGroupPrefix adds prefix for non-default", () => {
    setActiveProfile("work");
    expect(profileGroupPrefix()).toBe("work/");
    setActiveProfile("default"); // reset
  });
});
