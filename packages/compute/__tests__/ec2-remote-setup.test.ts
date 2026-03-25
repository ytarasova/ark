import { describe, it, expect } from "bun:test";

import {
  getGitRemoteUrl,
  resolveRepoUrl,
  getRepoName,
  cloneRepoOnRemote,
  trustRemoteDirectory,
  autoAcceptChannelPrompt,
} from "../providers/ec2/remote-setup.js";

describe("EC2 remote setup", () => {
  // -----------------------------------------------------------------------
  // getGitRemoteUrl
  // -----------------------------------------------------------------------
  describe("getGitRemoteUrl", () => {
    it("returns URL for a git repo (ark repo itself)", async () => {
      const url = await getGitRemoteUrl(process.cwd());
      expect(url).not.toBeNull();
      expect(typeof url).toBe("string");
    });

    it("returns null for non-git directory", async () => {
      const url = await getGitRemoteUrl("/tmp");
      expect(url).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // resolveRepoUrl
  // -----------------------------------------------------------------------
  describe("resolveRepoUrl", () => {
    it("converts org/repo to git@github.com:org/repo.git", async () => {
      expect(await resolveRepoUrl("org/repo")).toBe("git@github.com:org/repo.git");
    });

    it("returns https:// URLs as-is", async () => {
      expect(await resolveRepoUrl("https://github.com/org/repo")).toBe("https://github.com/org/repo");
    });

    it("returns git@ URLs as-is", async () => {
      expect(await resolveRepoUrl("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
    });

    it("extracts git remote from local path", async () => {
      const url = await resolveRepoUrl(process.cwd());
      expect(url).not.toBeNull();
      expect(typeof url).toBe("string");
    });
  });

  // -----------------------------------------------------------------------
  // getRepoName
  // -----------------------------------------------------------------------
  describe("getRepoName", () => {
    it("extracts repo name from git SSH URL", () => {
      expect(getRepoName("git@github.com:org/my-repo.git")).toBe("my-repo");
    });

    it("extracts repo name from local path", () => {
      expect(getRepoName("/Users/yana/Projects/ark")).toBe("ark");
    });

    it("extracts repo name from https URL", () => {
      expect(getRepoName("https://github.com/org/cool-project")).toBe("cool-project");
    });

    it("strips .git suffix", () => {
      expect(getRepoName("my-repo.git")).toBe("my-repo");
    });
  });

  // -----------------------------------------------------------------------
  // Exported async functions exist and are callable
  // -----------------------------------------------------------------------
  describe("exported functions", () => {
    it("cloneRepoOnRemote is a function", () => {
      expect(typeof cloneRepoOnRemote).toBe("function");
    });

    it("trustRemoteDirectory is a function", () => {
      expect(typeof trustRemoteDirectory).toBe("function");
    });

    it("autoAcceptChannelPrompt is a function", () => {
      expect(typeof autoAcceptChannelPrompt).toBe("function");
    });
  });
});
