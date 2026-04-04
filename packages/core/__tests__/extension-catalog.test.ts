import { describe, it, expect } from "bun:test";
import { EXTENSION_CATALOG, searchCatalog, getCatalogByCategory, getCatalogEntry } from "../extension-catalog.js";

describe("extension catalog", () => {
  it("has at least 10 extensions", () => {
    expect(EXTENSION_CATALOG.length).toBeGreaterThanOrEqual(10);
  });

  it("all entries have required fields", () => {
    for (const e of EXTENSION_CATALOG) {
      expect(e.name).toBeTruthy();
      expect(e.description).toBeTruthy();
      expect(e.command).toBeTruthy();
      expect(e.category).toBeTruthy();
    }
  });

  it("searchCatalog finds by name", () => {
    const results = searchCatalog("playwright");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("playwright");
  });

  it("searchCatalog finds by category", () => {
    const results = searchCatalog("browser");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("getCatalogByCategory groups correctly", () => {
    const groups = getCatalogByCategory();
    expect(Object.keys(groups).length).toBeGreaterThanOrEqual(3);
    expect(groups["browser"]?.length).toBeGreaterThanOrEqual(1);
  });

  it("getCatalogEntry returns specific entry", () => {
    const entry = getCatalogEntry("github");
    expect(entry).toBeDefined();
    expect(entry!.envKeys).toContain("GITHUB_TOKEN");
  });

  it("getCatalogEntry returns undefined for unknown", () => {
    expect(getCatalogEntry("nonexistent")).toBeUndefined();
  });
});
