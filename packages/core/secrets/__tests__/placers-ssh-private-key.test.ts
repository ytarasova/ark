import { describe, expect, test } from "bun:test";
import { _makeSshPrivateKeyPlacer, sshPrivateKeyPlacer } from "../placers/ssh-private-key.js";
import { MockPlacementCtx } from "./mock-placement-ctx.js";

/**
 * Tests use the `_makeSshPrivateKeyPlacer({ runKeyScan })` DI factory to stub
 * the network-touching `runKeyScan` helper. bun's `mock.module` is module-
 * scoped and bleeds into sibling tests, so we inject deps directly instead.
 */

describe("sshPrivateKeyPlacer", () => {
  test("happy path: writes key, appends config, appends known_hosts", async () => {
    const ctx = new MockPlacementCtx("/home/ubuntu");
    const placer = _makeSshPrivateKeyPlacer({
      runKeyScan: async () => Buffer.from("bitbucket.org ssh-rsa AAAA...\n"),
    });

    await placer.place(
      { name: "BB_KEY", type: "ssh-private-key", metadata: { host: "bitbucket.org" }, value: "PEM" },
      ctx,
    );

    const writeCalls = ctx.calls.filter((c) => c.kind === "writeFile");
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].kind === "writeFile" && writeCalls[0].path).toBe("/home/ubuntu/.ssh/id_bb_key");
    expect(writeCalls[0].kind === "writeFile" && writeCalls[0].mode).toBe(0o600);
    // Placer guarantees PEM trailing newline (OpenSSL libcrypto rejects
    // keys without it). The "PEM" fixture gets a `\n` appended at write time.
    expect(writeCalls[0].kind === "writeFile" && Buffer.from(writeCalls[0].bytes).toString()).toBe("PEM\n");

    const appendCalls = ctx.calls.filter((c) => c.kind === "appendFile");
    expect(appendCalls).toHaveLength(2);
    const config = appendCalls.find((c) => c.kind === "appendFile" && c.path.endsWith("/.ssh/config"));
    const knownHosts = appendCalls.find((c) => c.kind === "appendFile" && c.path.endsWith("/.ssh/known_hosts"));
    expect(config).toBeDefined();
    expect(config!.kind === "appendFile" && config!.marker).toBe("ark:secret:BB_KEY");
    expect(config!.kind === "appendFile" && Buffer.from(config!.bytes).toString()).toContain("Host bitbucket.org");
    expect(knownHosts!.kind === "appendFile" && knownHosts!.marker).toBe("ark:secret:BB_KEY");
    expect(knownHosts!.kind === "appendFile" && Buffer.from(knownHosts!.bytes).toString()).toContain(
      "bitbucket.org ssh-rsa",
    );
  });

  test("missing host metadata throws RequiredMetadataMissing", async () => {
    const ctx = new MockPlacementCtx();
    const placer = _makeSshPrivateKeyPlacer({ runKeyScan: async () => new Uint8Array() });
    await expect(
      placer.place({ name: "BB", type: "ssh-private-key", metadata: {}, value: "PEM" }, ctx),
    ).rejects.toThrow(/required metadata.*host/i);
  });

  test("missing value throws", async () => {
    const ctx = new MockPlacementCtx();
    const placer = _makeSshPrivateKeyPlacer({ runKeyScan: async () => new Uint8Array() });
    await expect(
      placer.place({ name: "BB", type: "ssh-private-key", metadata: { host: "bitbucket.org" } }, ctx),
    ).rejects.toThrow();
  });

  test("aliases land on the Host line", async () => {
    const ctx = new MockPlacementCtx();
    const placer = _makeSshPrivateKeyPlacer({ runKeyScan: async () => new Uint8Array() });
    await placer.place(
      {
        name: "BB",
        type: "ssh-private-key",
        metadata: { host: "bitbucket.org", aliases: "bitbucket.paytm.com" },
        value: "PEM",
      },
      ctx,
    );
    const config = ctx.calls.find((c) => c.kind === "appendFile" && c.path.endsWith("/.ssh/config"))!;
    expect(config.kind === "appendFile" && Buffer.from(config.bytes).toString()).toContain(
      "Host bitbucket.org bitbucket.paytm.com",
    );
  });

  test("target_path metadata overrides default key path", async () => {
    const ctx = new MockPlacementCtx();
    const placer = _makeSshPrivateKeyPlacer({ runKeyScan: async () => new Uint8Array() });
    await placer.place(
      {
        name: "BB",
        type: "ssh-private-key",
        metadata: { host: "bitbucket.org", target_path: "~/.ssh/custom_id" },
        value: "PEM",
      },
      ctx,
    );
    const w = ctx.calls.find((c) => c.kind === "writeFile")!;
    expect(w.kind === "writeFile" && w.path).toBe("/home/ubuntu/.ssh/custom_id");
  });

  test("rejects target_path with traversal", async () => {
    const ctx = new MockPlacementCtx();
    const placer = _makeSshPrivateKeyPlacer({ runKeyScan: async () => new Uint8Array() });
    await expect(
      placer.place(
        {
          name: "BB",
          type: "ssh-private-key",
          metadata: { host: "x", target_path: "~/../etc/x" },
          value: "PEM",
        },
        ctx,
      ),
    ).rejects.toThrow(/traversal/);
  });

  test("multiple aliases comma-separated", async () => {
    const ctx = new MockPlacementCtx();
    const placer = _makeSshPrivateKeyPlacer({ runKeyScan: async () => new Uint8Array() });
    await placer.place(
      {
        name: "BB",
        type: "ssh-private-key",
        metadata: { host: "h1", aliases: "h2,h3,h4" },
        value: "PEM",
      },
      ctx,
    );
    const config = ctx.calls.find((c) => c.kind === "appendFile" && c.path.endsWith("/.ssh/config"))!;
    expect(config.kind === "appendFile" && Buffer.from(config.bytes).toString()).toContain("Host h1 h2 h3 h4");
  });

  test("placer.type is ssh-private-key", () => {
    expect(sshPrivateKeyPlacer.type).toBe("ssh-private-key");
  });
});
