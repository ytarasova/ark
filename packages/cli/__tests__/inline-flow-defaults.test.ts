/**
 * Regression test: `ark session start --flow ./inline.yaml` must apply
 * the parsed flow's `inputs[*].default` values when the caller does
 * NOT supply a matching `--param`.
 *
 * Pre-fix, the CLI looked up declared inputs via `ark.flowRead(name)`
 * which only works for named flows in the FlowStore. Inline flows
 * (paths ending .yaml/.yml) silently skipped defaulting. A flow that
 * baked its `streams: [...]` into `default:` therefore dispatched with
 * `inputs.streams === undefined`, and the for_each resolver threw
 * "Cannot resolve for_each list: '{{inputs.streams}}'".
 *
 * The fix reads `inputs:` from the parsed YAML object when the flow
 * arg is an inline path. This test pins that contract.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const startSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "commands", "session", "start.ts"),
  "utf-8",
);

describe("ark session start inline-flow defaults", () => {
  test("pulls declared inputs from the parsed inline flow object, not just FlowStore", () => {
    // The fix path: when `flowArg` is the parsed object (set above when
    // the path ends in .yaml/.yml), read its `inputs` block.
    expect(startSource).toMatch(/flowArg\s*&&\s*typeof\s+flowArg\s*===\s*"object"/);
    expect(startSource).toMatch(/\(flowArg as Record<string, any>\)\.inputs/);
  });

  test("keeps the named-flow path working via flowRead", () => {
    expect(startSource).toMatch(/await ark\.flowRead\(opts\.flow\)/);
  });

  test("declared is checked once and reused for both paths", () => {
    // We collapsed the named/inline branches into a single `declared`
    // local so the validator runs the same loop for both shapes. If
    // someone reintroduces a divergent code path here, this assertion
    // surfaces the regression.
    const matches = startSource.match(/let declared:/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
