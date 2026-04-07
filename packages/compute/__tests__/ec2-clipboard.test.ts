import { describe, it, expect } from "bun:test";

import {
  getClipboardImage,
  uploadToSession,
  watchClipboard,
} from "../providers/ec2/clipboard.js";

describe("EC2 clipboard sync", () => {
  // -----------------------------------------------------------------------
  // getClipboardImage
  // -----------------------------------------------------------------------
  describe("getClipboardImage", () => {
    it("returns string or null without crashing", async () => {
      const result = await getClipboardImage();
      expect(result === null || typeof result === "string").toBe(true);
    }, 15_000);
  });

  // -----------------------------------------------------------------------
  // uploadToSession
  // -----------------------------------------------------------------------
  describe("uploadToSession", () => {
    it("is a function", () => {
      expect(typeof uploadToSession).toBe("function");
    });
  });

  // -----------------------------------------------------------------------
  // watchClipboard
  // -----------------------------------------------------------------------
  describe("watchClipboard", () => {
    it("returns an object with a stop function", () => {
      const handle = watchClipboard("/tmp/fake-key", "192.0.2.1", "/tmp", {
        intervalMs: 60_000,
      });
      expect(handle).toHaveProperty("stop");
      expect(typeof handle.stop).toBe("function");
      handle.stop();
    });

    it("stop cancels the interval without crashing", () => {
      const handle = watchClipboard("/tmp/fake-key", "192.0.2.1", "/tmp", {
        intervalMs: 60_000,
      });
      handle.stop();
      // Calling stop a second time should also be safe
      handle.stop();
    });
  });
});
