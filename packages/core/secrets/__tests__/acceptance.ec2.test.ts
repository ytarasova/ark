/**
 * Acceptance smoke test for typed-secret placement on EC2.
 *
 * Exercises the end-to-end Phase 1+2 flow with the two-phase placement model:
 *   1. Boot a real AppContext (forTestAsync).
 *   2. Set an `ssh-private-key` typed secret with metadata.host.
 *   3. Build a DeferredPlacementCtx (what RemoteArkdBase.buildPlacementCtx now
 *      returns) and run placeAllSecrets() against it. Pre-fix the test built
 *      a real EC2PlacementCtx directly, which masked the live-dispatch bug
 *      where an EC2PlacementCtx couldn't be built pre-launch (no IP).
 *   4. Build a stubbed EC2PlacementCtx and call deferred.flush(realCtx) -- this
 *      simulates the post-provision flush that happens inside
 *      RemoteArkdBase.flushDeferredPlacement during provider.launch.
 *   5. Assert the captured ssh commands look right (tar pipe for the key file,
 *      chmod 600, sed BEGIN/END marker replacement on ~/.ssh/config and
 *      ~/.ssh/known_hosts, and the base64 of the keyscan fixture lands in the
 *      known_hosts append cmd) -- proving the queued ops replay onto the real
 *      ctx unchanged.
 *
 * This is the integration check that gated T21 (deletion of the legacy
 * EC2 ssh sync step): with this passing, the typed-placement pipeline now
 * fully replaces the old rsync path on EC2.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { placeAllSecrets, __test_registerPlacer } from "../placement.js";
import { _makeSshPrivateKeyPlacer, sshPrivateKeyPlacer } from "../placers/ssh-private-key.js";
import { _makeEC2PlacementCtx } from "../../compute/providers/ec2/placement-ctx.js";
import { DeferredPlacementCtx } from "../deferred-placement-ctx.js";

describe("ARK-AC1: typed ssh-private-key placement on EC2", () => {
  let app: AppContext;
  const ssmExecCalls: string[] = [];
  const stubKeyscanBytes = Buffer.from("bitbucket.org ssh-rsa AAAA-fixture\n");

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    // Replace the ssh-private-key placer with a DI version that returns
    // deterministic ssh-keyscan bytes -- the test must never hit the network.
    const placerWithStub = _makeSshPrivateKeyPlacer({
      runKeyScan: async () => stubKeyscanBytes,
    });
    __test_registerPlacer("ssh-private-key", placerWithStub);
  });

  afterAll(async () => {
    // Restore the production placer so we don't leak the stub into other test
    // files that share the placer registry.
    __test_registerPlacer("ssh-private-key", sshPrivateKeyPlacer);
    await app?.shutdown();
    clearApp();
  });

  beforeEach(async () => {
    ssmExecCalls.length = 0;
    // Wipe + re-seed the BB_KEY secret to ensure isolation between cases.
    const refs = await app.secrets.list("default");
    for (const r of refs) await app.secrets.delete("default", r.name);
    await app.secrets.set("default", "BB_KEY", "PEM_BODY", {
      type: "ssh-private-key",
      metadata: { host: "bitbucket.org" },
    });
  });

  test("places key + ssh config + known_hosts on EC2 ctx via deferred flush", async () => {
    // Phase A: the dispatcher runs placement against a DeferredPlacementCtx.
    // No SSH commands fire here -- everything is queued. This is what
    // RemoteArkdBase.buildPlacementCtx now returns (pre-fix the dispatcher
    // tried to build an EC2PlacementCtx directly and crashed on the no-IP
    // path because the compute hadn't been provisioned yet).
    const deferred = new DeferredPlacementCtx();
    const session: any = { id: "s-acceptance", tenant_id: "default" };

    await placeAllSecrets(app, session, deferred);

    expect(ssmExecCalls).toHaveLength(0); // dispatcher never touched the wire
    expect(deferred.hasDeferred()).toBe(true); // file ops are queued

    // Phase B: post-provision the provider builds a real EC2PlacementCtx
    // (now the instance_id is known) and replays the queue. This is what
    // RemoteArkdBase.flushDeferredPlacement does inside provider.launch.
    const realCtx = _makeEC2PlacementCtx({
      instanceId: "i-acceptance",
      region: "us-east-1",
      ssmExec: async (_id, cmd) => {
        ssmExecCalls.push(cmd);
        return "";
      },
    });
    await deferred.flush(realCtx);

    // 1. The key file landed in /home/ubuntu/.ssh via the SSM base64-decode
    //    path. The same SendCommand carries mkdir + base64 + chmod.
    expect(
      ssmExecCalls.some(
        (c) => c.includes("/home/ubuntu/.ssh") && c.includes("base64 -d") && c.includes("/home/ubuntu/.ssh/id_bb_key"),
      ),
    ).toBe(true);

    // 2. chmod 600 was issued for the key.
    expect(ssmExecCalls.some((c) => c.includes("chmod 600") && c.includes("id_bb_key"))).toBe(true);

    // 3. sed marker replacement happened at least twice -- once for config,
    //    once for known_hosts.
    const sedCmds = ssmExecCalls.filter((c) => c.includes("sed") && c.includes("ark:secret:BB_KEY"));
    expect(sedCmds.length).toBeGreaterThanOrEqual(2);

    // 4. /.ssh/config command landed.
    expect(ssmExecCalls.some((c) => c.includes("/home/ubuntu/.ssh/config") && c.includes("ark:secret:BB_KEY"))).toBe(
      true,
    );

    // 5. /.ssh/known_hosts command landed.
    expect(
      ssmExecCalls.some((c) => c.includes("/home/ubuntu/.ssh/known_hosts") && c.includes("ark:secret:BB_KEY")),
    ).toBe(true);

    // 6. The base64 of the keyscan fixture appears in the known_hosts append cmd.
    const keyscanB64 = stubKeyscanBytes.toString("base64");
    expect(ssmExecCalls.some((c) => c.includes(keyscanB64))).toBe(true);

    // 7. The base64-encoded ssh config block decodes to a chunk containing
    //    "Host bitbucket.org". We can't grep for that string directly because
    //    appendFile wraps the bytes in `printf %s '<b64>' | base64 -d`.
    const containsConfigBlock = ssmExecCalls.some((c) => {
      const matches = [...c.matchAll(/'([A-Za-z0-9+/=]+)' \| base64 -d/g)];
      return matches.some((m) => Buffer.from(m[1], "base64").toString().includes("Host bitbucket.org"));
    });
    expect(containsConfigBlock).toBe(true);
  });

  test("session with no typed secrets is a no-op (no ssm exec calls)", async () => {
    // Wipe the seeded secret so the dispatcher has nothing to place.
    await app.secrets.delete("default", "BB_KEY");
    const deferred = new DeferredPlacementCtx();
    await placeAllSecrets(app, { id: "s-empty", tenant_id: "default" } as any, deferred);
    expect(deferred.hasDeferred()).toBe(false);

    // Even when we synthesize a flush against a real ctx, no SSM calls fire.
    const realCtx = _makeEC2PlacementCtx({
      instanceId: "i-acceptance-empty",
      region: "us-east-1",
      ssmExec: async (_id, cmd) => {
        ssmExecCalls.push(cmd);
        return "";
      },
    });
    await deferred.flush(realCtx);
    expect(ssmExecCalls).toHaveLength(0);
  });
});
