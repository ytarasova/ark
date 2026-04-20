/**
 * Security tests for tools/* handlers.
 *
 * Covers the fix for the `tools/delete` claude-skill arbitrary-file-unlink
 * bug from the 2026-04-19 audit: a remote caller must NOT be able to pass
 * an arbitrary `source` path and have arkd call `unlinkSync(source)`.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerToolsHandlers } from "../handlers/tools.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  router = new Router();
  registerToolsHandlers(router, app);
});

afterAll(async () => {
  await app?.shutdown();
});

describe("tools/delete security", () => {
  it("refuses to unlink files outside the claude skills dirs", async () => {
    // Create a decoy file that the handler MUST NOT be able to delete.
    const decoyDir = join(tmpdir(), `tools-sec-${Date.now()}`);
    mkdirSync(decoyDir, { recursive: true });
    const decoy = join(decoyDir, "do-not-delete.txt");
    writeFileSync(decoy, "sensitive");
    expect(existsSync(decoy)).toBe(true);

    const req = createRequest(1, "tools/delete", {
      kind: "claude-skill",
      name: "evil",
      source: decoy,
    });
    const res = await router.dispatch(req);

    // Handler must have thrown rather than unlinked.
    expect("error" in (res as JsonRpcError | JsonRpcResponse)).toBe(true);
    expect(existsSync(decoy)).toBe(true);
  });

  it("refuses path traversal through source param", async () => {
    const req = createRequest(2, "tools/delete", {
      kind: "claude-skill",
      name: "evil",
      source: "../../../../etc/passwd",
    });
    const res = await router.dispatch(req);
    // Should error out, not silently succeed.
    expect("error" in (res as JsonRpcError | JsonRpcResponse)).toBe(true);
  });
});
