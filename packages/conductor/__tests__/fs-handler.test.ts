/**
 * Unit tests for the fs/list-dir RPC handler.
 *
 * Covers: default to $HOME, directory listing, sorting, isGitRepo flag,
 * parent navigation, filesystem-root edge, non-existent path error. The
 * hosted-mode refusal contract lives in the register-mode test --
 * `registerLocalOnlyHandlers` skips this handler entirely in hosted mode
 * rather than refusing at runtime.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { join, parse } from "path";
import { tmpdir, homedir } from "os";

import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerFsHandlers } from "../handlers/fs.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
let router: Router;
let tmpRoot: string;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerFsHandlers(router, app);
  tmpRoot = mkdtempSync(join(tmpdir(), "ark-fs-test-"));
  // Layout:
  //   tmpRoot/
  //     alpha/
  //     Beta/
  //     gamma/
  //       .git/        ← marks gamma as a git repo
  //     zeta.txt       ← a file; must NOT appear in listing
  mkdirSync(join(tmpRoot, "alpha"));
  mkdirSync(join(tmpRoot, "Beta"));
  mkdirSync(join(tmpRoot, "gamma"));
  mkdirSync(join(tmpRoot, "gamma", ".git"));
  writeFileSync(join(tmpRoot, "zeta.txt"), "hello");
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function call(path?: string) {
  const req = createRequest(1, "fs/list-dir", path === undefined ? {} : { path });
  return router.dispatch(req);
}

describe("fs/list-dir handler", async () => {
  it("lists only directories, sorted case-insensitively", async () => {
    const res = (await call(tmpRoot)) as JsonRpcResponse;
    const result = res.result as any;
    expect(result.cwd).toBe(tmpRoot);
    expect(result.entries).toHaveLength(3);
    // Case-insensitive sort: alpha, Beta, gamma
    const names = result.entries.map((e: any) => e.name);
    expect(names).toEqual(["alpha", "Beta", "gamma"]);
    // zeta.txt must NOT appear
    expect(names).not.toContain("zeta.txt");
  });

  it("flags entries that contain a .git directory", async () => {
    const res = (await call(tmpRoot)) as JsonRpcResponse;
    const result = res.result as any;
    const gamma = result.entries.find((e: any) => e.name === "gamma");
    const alpha = result.entries.find((e: any) => e.name === "alpha");
    expect(gamma.isGitRepo).toBe(true);
    expect(alpha.isGitRepo).toBeUndefined();
  });

  it("returns each entry's absolute path", async () => {
    const res = (await call(tmpRoot)) as JsonRpcResponse;
    const result = res.result as any;
    for (const e of result.entries) {
      expect(e.path).toBe(join(tmpRoot, e.name));
    }
  });

  it("reports the parent directory (non-null except at filesystem root)", async () => {
    const sub = join(tmpRoot, "alpha");
    const res = (await call(sub)) as JsonRpcResponse;
    const result = res.result as any;
    expect(result.cwd).toBe(sub);
    expect(result.parent).toBe(tmpRoot);

    // Filesystem root has parent === null
    const rootRes = (await call(parse(tmpRoot).root)) as JsonRpcResponse;
    const rootResult = rootRes.result as any;
    expect(rootResult.parent).toBeNull();
  });

  it("defaults to the user's home directory when no path is given", async () => {
    const res = (await call()) as JsonRpcResponse;
    const result = res.result as any;
    expect(result.cwd).toBe(homedir());
    expect(result.home).toBe(homedir());
  });

  it("treats '.' as 'default to home' rather than process cwd", async () => {
    const res = (await call(".")) as JsonRpcResponse;
    const result = res.result as any;
    expect(result.cwd).toBe(homedir());
  });

  it("expands a leading ~ to the home directory", async () => {
    const res = (await call("~")) as JsonRpcResponse;
    const result = res.result as any;
    expect(result.cwd).toBe(homedir());
  });

  it("returns an RPC error for a non-existent path", async () => {
    const bogus = join(tmpRoot, "does-not-exist-xyz");
    const res = (await call(bogus)) as JsonRpcError;
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("does not exist");
  });

  it("rejects a path that points at a file", async () => {
    const filePath = join(tmpRoot, "zeta.txt");
    const res = (await call(filePath)) as JsonRpcError;
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("Not a directory");
  });

  it("rejects a relative path that slipped past the defaults", async () => {
    const res = (await call("some/relative/path")) as JsonRpcError;
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("absolute");
  });
});
