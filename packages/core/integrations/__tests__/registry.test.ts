import { describe, expect, test } from "bun:test";
import { buildIntegrationCatalog, getIntegration, listIntegrations } from "../registry.js";

describe("integration catalog", () => {
  test("contains github with both trigger + connector halves", () => {
    const gh = getIntegration("github");
    expect(gh).not.toBeNull();
    expect(gh?.trigger).toBeDefined();
    expect(gh?.connector).toBeDefined();
    expect(gh?.trigger?.status).toBe("full");
    expect(gh?.connector?.status).toBe("full");
  });

  test("trigger-only entries are surfaced (alertmanager, cloudwatch, pagerduty, prometheus)", () => {
    for (const name of ["alertmanager", "cloudwatch", "pagerduty", "prometheus"]) {
      const i = getIntegration(name);
      expect(i?.trigger).toBeDefined();
      expect(i?.connector).toBeUndefined();
    }
  });

  test("alphabetical ordering", () => {
    const names = listIntegrations().map((i) => i.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  test("status is max over the two halves", () => {
    // jira trigger: full; connector: full -> full
    expect(getIntegration("jira")?.status).toBe("full");
    // bitbucket: trigger full, connector scaffolded -> full (most mature)
    expect(getIntegration("bitbucket")?.status).toBe("full");
    // alertmanager trigger-only, scaffolded -> scaffolded
    expect(getIntegration("alertmanager")?.status).toBe("scaffolded");
  });

  test("buildIntegrationCatalog is deterministic across calls", () => {
    const a = buildIntegrationCatalog().map((i) => i.name);
    const b = buildIntegrationCatalog().map((i) => i.name);
    expect(a).toEqual(b);
  });
});
