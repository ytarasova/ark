/**
 * Tests for TUI constants — icon and color mappings for session statuses.
 */

import { describe, it, expect } from "bun:test";
import { ICON, COLOR } from "../constants.js";

const ALL_STATUSES = [
  "running", "ready", "pending", "stopped",
  "waiting", "blocked", "completed", "failed",
];

describe("ICON constant", () => {
  it("has entries for all expected statuses", () => {
    for (const status of ALL_STATUSES) {
      expect(ICON[status]).toBeDefined();
    }
  });

  it("running icon is filled circle", () => {
    expect(ICON.running).toBe("●");
  });

  it("ready icon is target circle", () => {
    expect(ICON.ready).toBe("◎");
  });

  it("pending icon is empty circle", () => {
    expect(ICON.pending).toBe("○");
  });

  it("stopped icon is square", () => {
    expect(ICON.stopped).toBe("■");
  });

  it("waiting icon is half circle", () => {
    expect(ICON.waiting).toBe("◑");
  });

  it("blocked icon is half circle", () => {
    expect(ICON.blocked).toBe("◐");
  });

  it("completed icon is checkmark", () => {
    expect(ICON.completed).toBe("✔");
  });

  it("failed icon is x-mark", () => {
    expect(ICON.failed).toBe("✖");
  });

  it("has exactly 8 entries", () => {
    expect(Object.keys(ICON).length).toBe(8);
  });

  it("all icon values are single characters", () => {
    for (const [, icon] of Object.entries(ICON)) {
      expect(icon.length).toBe(1);
    }
  });
});

describe("COLOR constant", () => {
  it("has entries for all expected statuses", () => {
    for (const status of ALL_STATUSES) {
      expect(COLOR[status]).toBeDefined();
    }
  });

  it("running color is green", () => {
    expect(COLOR.running).toBe("green");
  });

  it("ready color is cyan", () => {
    expect(COLOR.ready).toBe("cyan");
  });

  it("pending color is gray", () => {
    expect(COLOR.pending).toBe("gray");
  });

  it("stopped color is gray", () => {
    expect(COLOR.stopped).toBe("gray");
  });

  it("waiting color is yellow", () => {
    expect(COLOR.waiting).toBe("yellow");
  });

  it("blocked color is yellow", () => {
    expect(COLOR.blocked).toBe("yellow");
  });

  it("completed color is green", () => {
    expect(COLOR.completed).toBe("green");
  });

  it("failed color is red", () => {
    expect(COLOR.failed).toBe("red");
  });

  it("has exactly 8 entries", () => {
    expect(Object.keys(COLOR).length).toBe(8);
  });

  it("all color values are non-empty strings", () => {
    for (const [, color] of Object.entries(COLOR)) {
      expect(typeof color).toBe("string");
      expect(color.length).toBeGreaterThan(0);
    }
  });
});

describe("ICON and COLOR alignment", () => {
  it("have the same set of keys", () => {
    expect(Object.keys(ICON).sort()).toEqual(Object.keys(COLOR).sort());
  });

  it("every status has both an icon and a color", () => {
    for (const status of ALL_STATUSES) {
      expect(ICON[status]).toBeTruthy();
      expect(COLOR[status]).toBeTruthy();
    }
  });
});
