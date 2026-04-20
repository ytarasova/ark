/**
 * Structural regression guard: every auto-gate builtin agent YAML MUST put
 * its "Completion protocol" block at the very top of system_prompt, with
 * the exact instruction that the final output MUST be a `report` tool call.
 *
 * This enforces the prompt-quality convention that prevents agents from
 * ending in a chat summary and stalling the flow (the orchestrator keys off
 * the `report` tool call, not natural-language output). See `session-hooks.ts`
 * for the auto-advance logic that keys off SessionEnd + report.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { resolveStoreBaseDir } from "../install-paths.js";

const AUTO_GATE_AGENTS = [
  "planner",
  "worker",
  "implementer",
  "task-implementer",
  "verifier",
  "reviewer",
  "documenter",
  "closer",
  "retro",
  "spec-planner",
  "plan-auditor",
  "ticket-intake",
] as const;

const REQUIRED_SENTENCE = "FINAL output MUST be a call to the `report` tool";

function loadAgentYaml(name: string): { system_prompt: string; path: string } {
  const builtinDir = join(resolveStoreBaseDir(), "agents");
  const path = join(builtinDir, `${name}.yaml`);
  if (!existsSync(path)) {
    throw new Error(`Builtin agent YAML missing: ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = YAML.parse(raw) as { system_prompt?: string };
  return { system_prompt: parsed?.system_prompt ?? "", path };
}

describe("auto-gate agent Completion protocol", () => {
  for (const agentName of AUTO_GATE_AGENTS) {
    it(`${agentName}.yaml hoists the Completion protocol to the top of system_prompt`, () => {
      const { system_prompt } = loadAgentYaml(agentName);
      expect(system_prompt.length).toBeGreaterThan(0);

      // The Completion protocol heading must appear early -- after the one-line
      // role description and before any other "##" section. We assert that the
      // first "##" heading in the prompt is the Completion protocol block.
      const firstHeadingIdx = system_prompt.indexOf("## ");
      expect(firstHeadingIdx).toBeGreaterThan(-1);
      const firstHeadingLine = system_prompt.slice(firstHeadingIdx).split("\n")[0];
      expect(firstHeadingLine).toContain("## Completion protocol");
    });

    it(`${agentName}.yaml contains the authoritative report-tool sentence`, () => {
      const { system_prompt } = loadAgentYaml(agentName);
      expect(system_prompt).toContain(REQUIRED_SENTENCE);
    });

    it(`${agentName}.yaml has only one Completion protocol block`, () => {
      const { system_prompt } = loadAgentYaml(agentName);
      const matches = system_prompt.match(/## Completion protocol/g) ?? [];
      expect(matches.length).toBe(1);
    });
  }
});

describe("Completion protocol structural regression guard", () => {
  it("catches agents missing the Completion protocol block", () => {
    // Simulated bad prompt (what a poorly-written agent would look like): no
    // Completion protocol heading and no "report tool" instruction. Confirms
    // the two positive assertions above would fail for such a file.
    const bad = "You are a test agent.\n\n## Approach\nDo stuff.\n\n## Completion\nCall report.";
    expect(bad.indexOf("## Completion protocol")).toBe(-1);
    expect(bad).not.toContain(REQUIRED_SENTENCE);
  });
});
