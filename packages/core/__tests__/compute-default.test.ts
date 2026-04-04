import { describe, it, expect } from "bun:test";
import { loadConfig } from "../config.js";

describe("compute default config", () => {
  it("loadConfig includes default_compute field", () => {
    const config = loadConfig();
    expect("default_compute" in config).toBe(true);
  });
});
