import { describe, expect, test } from "bun:test";
import { DefaultTriggerMatcher, defaultMatcher } from "../matcher.js";
import type { NormalizedEvent, TriggerConfig } from "../types.js";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    source: "github",
    event: "pull_request.opened",
    ref: "feature/x",
    payload: { repo: "acme/site", action: "opened" },
    receivedAt: 1,
    ...overrides,
  };
}

function config(overrides: Partial<TriggerConfig> = {}): TriggerConfig {
  return {
    name: "t",
    source: "github",
    flow: "review-pr",
    enabled: true,
    ...overrides,
  };
}

describe("DefaultTriggerMatcher", () => {
  test("matches when source + event agree", () => {
    const matcher = new DefaultTriggerMatcher();
    const out = matcher.match(event(), [config({ event: "pull_request.opened" })]);
    expect(out).toHaveLength(1);
  });

  test("event wildcard (missing event field) matches any event for the source", () => {
    const out = defaultMatcher.match(event(), [config()]);
    expect(out).toHaveLength(1);
  });

  test("source mismatch excludes the config", () => {
    const out = defaultMatcher.match(event(), [config({ source: "bitbucket" })]);
    expect(out).toHaveLength(0);
  });

  test("event mismatch excludes", () => {
    const out = defaultMatcher.match(event(), [config({ event: "push" })]);
    expect(out).toHaveLength(0);
  });

  test("match filter -- dotted payload key equality", () => {
    const out = defaultMatcher.match(event(), [config({ match: { repo: "acme/site" } })]);
    expect(out).toHaveLength(1);
  });

  test("match filter -- missing key excludes", () => {
    const out = defaultMatcher.match(event(), [config({ match: { repo: "other/thing" } })]);
    expect(out).toHaveLength(0);
  });

  test("match filter -- JSONPath override with $.", () => {
    const out = defaultMatcher.match(event(), [config({ match: { "$.ref": "feature/x" } })]);
    expect(out).toHaveLength(1);
  });

  test("enabled=false is skipped", () => {
    const out = defaultMatcher.match(event(), [config({ enabled: false })]);
    expect(out).toHaveLength(0);
  });

  test("number+boolean coercion through string", () => {
    const ev = event({ payload: { count: "42", ok: "true" } });
    const out = defaultMatcher.match(ev, [config({ match: { count: 42, ok: true } })]);
    expect(out).toHaveLength(1);
  });
});
