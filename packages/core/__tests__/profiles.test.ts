import { describe, it, expect } from "bun:test";
import {
  listProfiles,
  createProfile,
  deleteProfile,
  getActiveProfile,
  setActiveProfile,
  profileGroupPrefix,
} from "../state/profiles.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("profiles", () => {
  it("listProfiles returns at least default", () => {
    const profiles = listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    expect(profiles.find((p) => p.name === "default")).toBeDefined();
  });

  it("createProfile adds a new profile", () => {
    createProfile("work", "Work profile");
    const profiles = listProfiles();
    expect(profiles.find((p) => p.name === "work")).toBeDefined();
  });

  it("createProfile rejects duplicates", () => {
    createProfile("dup-test");
    expect(() => createProfile("dup-test")).toThrow("already exists");
  });

  it("deleteProfile removes a profile", () => {
    createProfile("temp");
    expect(deleteProfile("temp")).toBe(true);
    expect(listProfiles().find((p) => p.name === "temp")).toBeUndefined();
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

describe("profile-scoped session listing", () => {
  it("listSessions with groupPrefix filters by prefix", () => {
    getApp().sessions.create({ summary: "work-task", group_name: "work/frontend" });
    getApp().sessions.create({ summary: "personal-task", group_name: "personal/blog" });

    const workSessions = getApp().sessions.list({ groupPrefix: "work/" });
    expect(workSessions.every((s) => s.group_name?.startsWith("work/"))).toBe(true);
    expect(workSessions.some((s) => s.summary === "work-task")).toBe(true);
    expect(workSessions.some((s) => s.summary === "personal-task")).toBe(false);

    const personalSessions = getApp().sessions.list({ groupPrefix: "personal/" });
    expect(personalSessions.every((s) => s.group_name?.startsWith("personal/"))).toBe(true);
    expect(personalSessions.some((s) => s.summary === "personal-task")).toBe(true);
    expect(personalSessions.some((s) => s.summary === "work-task")).toBe(false);
  });

  it("listSessions without groupPrefix returns all", () => {
    getApp().sessions.create({ summary: "all-1", group_name: "work/a" });
    getApp().sessions.create({ summary: "all-2", group_name: "personal/b" });
    const all = getApp().sessions.list();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("groupPrefix does not match sessions without group_name", () => {
    getApp().sessions.create({ summary: "ungrouped" });
    getApp().sessions.create({ summary: "grouped", group_name: "work/misc" });

    const workSessions = getApp().sessions.list({ groupPrefix: "work/" });
    expect(workSessions.some((s) => s.summary === "ungrouped")).toBe(false);
    expect(workSessions.some((s) => s.summary === "grouped")).toBe(true);
  });
});
