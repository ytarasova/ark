import { describe, it, expect } from "bun:test";
import { loadUiState, saveUiState } from "../state/ui-state.js";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("UI state persistence", () => {
  it("loadUiState returns defaults when no file exists", () => {
    const state = loadUiState(getApp().config.arkDir);
    expect(state.activeTab).toBe(0);
    expect(state.selectedSessionId).toBeNull();
    expect(state.scrollOffset).toBe(0);
    expect(state.statusFilter).toBeNull();
  });

  it("saveUiState and loadUiState round-trip", () => {
    saveUiState({ activeTab: 3, selectedSessionId: "s-123" }, getApp().config.arkDir);
    const loaded = loadUiState(getApp().config.arkDir);
    expect(loaded.activeTab).toBe(3);
    expect(loaded.selectedSessionId).toBe("s-123");
    // Defaults preserved for unset fields
    expect(loaded.scrollOffset).toBe(0);
  });

  it("saveUiState merges with existing state", () => {
    saveUiState({ activeTab: 2 }, getApp().config.arkDir);
    saveUiState({ statusFilter: "running" }, getApp().config.arkDir);
    const loaded = loadUiState(getApp().config.arkDir);
    expect(loaded.activeTab).toBe(2);
    expect(loaded.statusFilter).toBe("running");
  });

  it("loadUiState handles corrupt file gracefully", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writeFileSync } = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require("path");
    writeFileSync(join(getApp().config.arkDir, "ui-state.json"), "not json{{{");
    const state = loadUiState(getApp().config.arkDir);
    expect(state.activeTab).toBe(0); // defaults
  });
});
