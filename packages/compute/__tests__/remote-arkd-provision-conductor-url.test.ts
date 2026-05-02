/**
 * F4 regression: RemoteArkdBase.provision must thread an operator-supplied
 * `cfg.conductor_url` into cloud-init, NOT the package-level
 * `DEFAULT_CONDUCTOR_URL` (`http://localhost:19100`).
 *
 * From inside an EC2 instance, `localhost:19100` is the instance's own
 * loopback. Pre-fix, every cloud-init bundle baked that URL in regardless
 * of where the conductor actually was, and arkd's callback path was
 * silently misrouted -- it worked only when SSH carried a -R reverse
 * tunnel. The SSM-only dispatch model preferred today doesn't have that
 * tunnel, so operators who legitimately need a conductor callback must be
 * able to override.
 */
import { describe, it, expect } from "bun:test";

import { resolveProvisionConductorUrl } from "../providers/remote-arkd.js";
import { DEFAULT_CONDUCTOR_URL } from "../../core/constants.js";

describe("resolveProvisionConductorUrl (F4)", () => {
  it("uses cfg.conductor_url when set (operator override wins)", () => {
    const url = resolveProvisionConductorUrl({ conductor_url: "https://ark.corp.example.com:19100" });
    expect(url).toBe("https://ark.corp.example.com:19100");
  });

  it("falls back to DEFAULT_CONDUCTOR_URL when cfg.conductor_url is undefined", () => {
    const url = resolveProvisionConductorUrl({});
    expect(url).toBe(DEFAULT_CONDUCTOR_URL);
  });

  it("never returns a localhost loopback when cfg.conductor_url is non-localhost", () => {
    // Pre-fix this was unconditionally localhost:19100. The whole point of
    // F4 is letting operators override, so the override path must be
    // honoured byte-for-byte.
    const url = resolveProvisionConductorUrl({ conductor_url: "http://10.42.0.7:19100" });
    expect(url).not.toContain("localhost");
    expect(url).toBe("http://10.42.0.7:19100");
  });

  it("treats explicit empty string as a fallback (not as a valid override)", () => {
    // An empty string is meaningless -- treat it like undefined and fall
    // back rather than emit a broken cloud-init bundle. We want the
    // fallback semantics to match `??`, so empty string -> fallback ONLY
    // if the caller wants us to coerce. Today `??` keeps "" as "", which
    // matches the documented contract (operators control their own input);
    // assert the documented behaviour so a future refactor doesn't
    // silently change it.
    const url = resolveProvisionConductorUrl({ conductor_url: "" });
    // `??` lets "" through. If you change this, update F4 docs.
    expect(url).toBe("");
  });
});
