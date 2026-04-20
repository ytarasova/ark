import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createFileTriggerStore } from "../store.js";
import { resolveSecret, secretEnvVar } from "../secrets.js";

function tempArkDir(): string {
  return mkdtempSync(join(tmpdir(), "ark-trig-test-"));
}

describe("FileTriggerStore", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  test("loads .yaml and .yml configs; skips .example", () => {
    const arkDir = tempArkDir();
    created.push(arkDir);
    const userDir = join(arkDir, "triggers");
    mkdirSync(userDir, { recursive: true });

    writeFileSync(
      join(userDir, "gh.yaml"),
      [
        "name: gh-pr",
        "source: github",
        "event: pull_request.opened",
        "flow: review-pr",
        "match: { repo: acme/foo }",
      ].join("\n"),
    );
    writeFileSync(
      join(userDir, "bb.yml"),
      ["name: bb-push", "source: bitbucket", "event: repo.push", "flow: ci"].join("\n"),
    );
    writeFileSync(join(userDir, "note.yaml.example"), "name: noop");

    const store = createFileTriggerStore({ arkDir });
    const list = store.list();
    expect(list.map((c) => c.name).sort()).toEqual(["bb-push", "gh-pr"]);
    expect(store.get("gh-pr")?.flow).toBe("review-pr");
    expect(store.get("gh-pr")?.enabled).toBe(true);
  });

  test("tenant directory overrides global", () => {
    const arkDir = tempArkDir();
    created.push(arkDir);
    const userDir = join(arkDir, "triggers");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(join(userDir, "paytm"), { recursive: true });
    writeFileSync(join(userDir, "gh.yaml"), ["name: gh", "source: github", "flow: global-flow"].join("\n"));
    writeFileSync(join(userDir, "paytm", "gh.yaml"), ["name: gh", "source: github", "flow: paytm-flow"].join("\n"));

    const store = createFileTriggerStore({ arkDir });
    expect(store.get("gh", "default")?.flow).toBe("global-flow");
    expect(store.get("gh", "paytm")?.flow).toBe("paytm-flow");
  });

  test("enable/disable is in-memory only", () => {
    const arkDir = tempArkDir();
    created.push(arkDir);
    const userDir = join(arkDir, "triggers");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "gh.yaml"), ["name: gh", "source: github", "flow: f"].join("\n"));

    const store = createFileTriggerStore({ arkDir });
    expect(store.enable("gh", false)).toBe(true);
    expect(store.get("gh")?.enabled).toBe(false);
    expect(store.enable("missing", true)).toBe(false);
  });

  test("reload clears cached parses", () => {
    const arkDir = tempArkDir();
    created.push(arkDir);
    const userDir = join(arkDir, "triggers");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "gh.yaml"), ["name: gh", "source: github", "flow: v1"].join("\n"));

    const store = createFileTriggerStore({ arkDir });
    expect(store.get("gh")?.flow).toBe("v1");

    writeFileSync(join(userDir, "gh.yaml"), ["name: gh", "source: github", "flow: v2"].join("\n"));
    store.reload();
    expect(store.get("gh")?.flow).toBe("v2");
  });
});

describe("resolveSecret", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
    delete process.env.ARK_TRIGGER_GITHUB_SECRET;
  });

  test("env var fallback", () => {
    const arkDir = tempArkDir();
    created.push(arkDir);
    process.env.ARK_TRIGGER_GITHUB_SECRET = "from-env";
    expect(resolveSecret(arkDir, "github")).toBe("from-env");
  });

  test("YAML tenant-scoped key wins over tenant-agnostic", () => {
    const arkDir = tempArkDir();
    created.push(arkDir);
    writeFileSync(
      join(arkDir, "secrets.yaml"),
      ["triggers:", "  github:", "    signing_key: generic", "    paytm:", "      signing_key: paytm-only"].join("\n"),
    );
    expect(resolveSecret(arkDir, "github", "paytm")).toBe("paytm-only");
    expect(resolveSecret(arkDir, "github", "default")).toBe("generic");
  });

  test("env var for dashed source name", () => {
    expect(secretEnvVar("generic-hmac")).toBe("ARK_TRIGGER_GENERIC_HMAC_SECRET");
  });

  test("returns null when nothing configured", () => {
    const arkDir = tempArkDir();
    created.push(arkDir);
    expect(resolveSecret(arkDir, "unknown")).toBeNull();
  });
});
