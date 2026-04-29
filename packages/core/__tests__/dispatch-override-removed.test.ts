/**
 * Follow-up to the schema rewrite: verifies that dispatch-core / executor /
 * eval paths no longer READ session-level `runtime_override` or
 * `model_override`. The CLI flags that wrote those fields have been removed;
 * this test guards against regressions that re-introduce a dual path.
 *
 * Strategy: grep the compiled source files rather than spinning up a full
 * dispatch. A behavioural test would require the full launcher + tmux + repo
 * fixtures; a string-level check is sufficient to lock the rule in place since
 * the rule IS "these names never appear as config reads in these files".
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(REPO, rel), "utf-8");
}

describe("dispatch / executor no longer read session.config.runtime_override", () => {
  it("dispatch-core.ts does not reference runtime_override", () => {
    const src = read("packages/core/services/dispatch/dispatch-core.ts");
    expect(src).not.toMatch(/runtime_override/);
  });

  it("dispatch-core.ts does not reference model_override", () => {
    const src = read("packages/core/services/dispatch/dispatch-core.ts");
    expect(src).not.toMatch(/model_override/);
  });

  it("agent-sdk executor does not reference session.config.model_override", () => {
    const src = read("packages/core/executors/agent-sdk.ts");
    // Comments describing the removal may mention the old name; ensure we
    // never read it off session.config directly.
    expect(src).not.toMatch(/config\?\.model_override/);
    expect(src).not.toMatch(/config\.model_override/);
  });

  it("subagents.ts does not write session.config.model_override", () => {
    const src = read("packages/core/services/subagents.ts");
    expect(src).not.toMatch(/model_override:/);
  });

  it("evals.ts does not read runtime_override off session.config", () => {
    const src = read("packages/core/knowledge/evals.ts");
    expect(src).not.toMatch(/runtime_override/);
  });

  it("SessionConfig type no longer declares model_override", () => {
    const src = read("packages/types/session.ts");
    expect(src).not.toMatch(/model_override/);
  });
});
