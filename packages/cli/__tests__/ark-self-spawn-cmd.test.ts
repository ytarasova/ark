/**
 * Regression: arkSelfSpawnCmd MUST exec the compiled binary directly when
 * running from a Bun-compiled bundle (argv[1] = "/$bunfs/...") -- spawning
 * `bun <virtualPath>` blows up because (a) there's no external `bun` on the
 * host PATH and (b) /$bunfs/... is a virtual path inside the binary itself.
 *
 * This bug shipped in two copies (app-client.ts auto-spawn + server-daemon.ts
 * --detach), each fixed independently. Now there's a single helper and this
 * test pins both modes.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { arkSelfSpawnCmd } from "../helpers.js";

const originalArgv1 = process.argv[1];

afterEach(() => {
  process.argv[1] = originalArgv1;
});

describe("arkSelfSpawnCmd", () => {
  it("execs process.execPath directly when running from a compiled bundle", () => {
    process.argv[1] = "/$bunfs/root/ark-linux-x64";
    const cmd = arkSelfSpawnCmd(["server", "daemon", "start", "--port", "19400"]);
    expect(cmd[0]).toBe(process.execPath);
    expect(cmd[1]).toBe("server");
    expect(cmd).not.toContain("/$bunfs/root/ark-linux-x64");
    expect(cmd[0]).not.toBe("bun");
  });

  it("uses `bun <script>` when running from source (dev / test)", () => {
    process.argv[1] = "/Users/me/src/ark/packages/cli/index.ts";
    const cmd = arkSelfSpawnCmd(["server", "daemon", "start", "--port", "19400"]);
    expect(cmd[0]).toBe("bun");
    expect(cmd[1]).toBe("/Users/me/src/ark/packages/cli/index.ts");
    expect(cmd[2]).toBe("server");
  });

  it("throws when neither bundle path nor argv[1] is available", () => {
    delete (process.argv as any)[1];
    expect(() => arkSelfSpawnCmd(["x"])).toThrow(/no process\.argv\[1\]/);
  });
});
