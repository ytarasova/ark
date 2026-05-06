import { describe, it, expect } from "bun:test";
import { userInfo } from "os";

import { rewritePaths, SYNC_STEPS, syncToHost, syncProjectFiles } from "../providers/ec2/sync.js";

describe("EC2 environment sync", () => {
  const username = userInfo().username;

  // -----------------------------------------------------------------------
  // rewritePaths
  // -----------------------------------------------------------------------
  describe("rewritePaths", () => {
    it("converts /Users/{user} to /home/ubuntu on push", () => {
      const input = `/Users/${username}/.config/some.json`;
      const result = rewritePaths(input, "push");
      expect(result).toBe("/home/ubuntu/.config/some.json");
    });

    it("converts /home/ubuntu to /Users/{user} on pull", () => {
      const input = "/home/ubuntu/.config/some.json";
      const result = rewritePaths(input, "pull");
      expect(result).toBe(`/Users/${username}/.config/some.json`);
    });

    it("handles content with no paths (returns unchanged)", () => {
      const input = "no paths here, just plain text";
      expect(rewritePaths(input, "push")).toBe(input);
      expect(rewritePaths(input, "pull")).toBe(input);
    });
  });

  // -----------------------------------------------------------------------
  // SYNC_STEPS
  // -----------------------------------------------------------------------
  describe("SYNC_STEPS", () => {
    it("has 4 entries", () => {
      // ssh was removed -- ssh credentials now flow via typed-secret placement
      // (see packages/core/secrets/placers/ssh-private-key.ts)
      expect(SYNC_STEPS).toHaveLength(4);
    });

    it("does not include an 'ssh' step", () => {
      const names = SYNC_STEPS.map((s) => s.name);
      expect(names).not.toContain("ssh");
    });

    it("each step has name, push, and pull functions", () => {
      const expectedNames = ["aws", "git", "gh", "claude"];
      for (let i = 0; i < SYNC_STEPS.length; i++) {
        const step = SYNC_STEPS[i];
        expect(step.name).toBe(expectedNames[i]);
        expect(typeof step.push).toBe("function");
        expect(typeof step.pull).toBe("function");
      }
    });
  });

  // -----------------------------------------------------------------------
  // syncToHost / syncProjectFiles - type checks
  // -----------------------------------------------------------------------
  describe("syncToHost", () => {
    it("is a function", () => {
      expect(typeof syncToHost).toBe("function");
    });
  });

  describe("syncProjectFiles", () => {
    it("is a function", () => {
      expect(typeof syncProjectFiles).toBe("function");
    });
  });
});
