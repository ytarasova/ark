import { describe, it, expect } from "bun:test";
import { NotifyDaemon } from "../notify-daemon.js";
import { Bridge } from "../bridge.js";

describe("NotifyDaemon", () => {
  it("constructs without error", () => {
    const bridge = new Bridge({});
    const daemon = new NotifyDaemon(bridge);
    expect(daemon).toBeDefined();
  });

  it("start and stop are safe", () => {
    const bridge = new Bridge({});
    const daemon = new NotifyDaemon(bridge);
    daemon.start();
    daemon.stop();
  });

  it("stop is idempotent", () => {
    const bridge = new Bridge({});
    const daemon = new NotifyDaemon(bridge);
    daemon.stop();
    daemon.stop();
  });

  it("start is idempotent", () => {
    const bridge = new Bridge({});
    const daemon = new NotifyDaemon(bridge);
    daemon.start();
    daemon.start();
    daemon.stop();
  });
});
