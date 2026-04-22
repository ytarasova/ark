/**
 * Session inputs plumbing: `session/start` carries generic files + params
 * through to `session.config.inputs`, which `buildSessionVars` flattens as
 * `inputs.files.*` / `inputs.params.*` for templating consumers.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { buildSessionVars, substituteVars } from "../template.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("session inputs plumbing", async () => {
  it("persists inputs.files + inputs.params into session.config.inputs", async () => {
    const session = await app.sessionLifecycle.start({
      summary: "inputs-test",
      repo: ".",
      flow: "bare",
      inputs: {
        files: { recipe: "/tmp/r.yaml", prd: "/tmp/prd.md" },
        params: { jira_key: "IN-1234", auto: "false" },
      },
    });
    const config = session.config as Record<string, unknown>;
    const inputs = config.inputs as { files: Record<string, string>; params: Record<string, string> };

    expect(inputs.files.recipe).toBe("/tmp/r.yaml");
    expect(inputs.files.prd).toBe("/tmp/prd.md");
    expect(inputs.params.jira_key).toBe("IN-1234");
    expect(inputs.params.auto).toBe("false");
  });

  it("omits inputs when none supplied (no empty bag in config)", async () => {
    const session = await app.sessionLifecycle.start({ summary: "no-inputs", repo: ".", flow: "bare" });
    const config = session.config as Record<string, unknown>;
    expect(config.inputs).toBeUndefined();
  });

  it("buildSessionVars + substituteVars resolve {{inputs.files.X}} / {{inputs.params.X}}", async () => {
    const session = await app.sessionLifecycle.start({
      summary: "template-test",
      repo: ".",
      flow: "bare",
      inputs: {
        files: { recipe: "/tmp/goose.yaml" },
        params: { jira_key: "IN-99" },
      },
    });
    const vars = buildSessionVars(session as unknown as Record<string, unknown>);
    const rendered = substituteVars("recipe={{inputs.files.recipe}} key={{inputs.params.jira_key}}", vars);
    expect(rendered).toBe("recipe=/tmp/goose.yaml key=IN-99");
  });
});
