import { describe, it, expect } from "bun:test";
import { loadUiState, saveUiState } from "../ui-state.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("UI state persistence", () => {
  it("loadUiState returns defaults when no file exists", () => {
    const state = loadUiState();
    expect(state.activeTab).toBe(0);
    expect(state.selectedSessionId).toBeNull();
    expect(state.scrollOffset).toBe(0);
    expect(state.statusFilter).toBeNull();
  });

  it("saveUiState and loadUiState round-trip", () => {
    saveUiState({ activeTab: 3, selectedSessionId: "s-123" });
    const loaded = loadUiState();
    expect(loaded.activeTab).toBe(3);
    expect(loaded.selectedSessionId).toBe("s-123");
    // Defaults preserved for unset fields
    expect(loaded.scrollOffset).toBe(0);
  });

  it("saveUiState merges with existing state", () => {
    saveUiState({ activeTab: 2 });
    saveUiState({ statusFilter: "running" });
    const loaded = loadUiState();
    expect(loaded.activeTab).toBe(2);
    expect(loaded.statusFilter).toBe("running");
  });

  it("loadUiState handles corrupt file gracefully", () => {
    const { writeFileSync } = require("fs");
    const { join } = require("path");
    const { ARK_DIR } = require("../store.js");
    writeFileSync(join(ARK_DIR(), "ui-state.json"), "not json{{{");
    const state = loadUiState();
    expect(state.activeTab).toBe(0); // defaults
  });
});
