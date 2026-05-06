/**
 * Pin the public barrel surfaces so accidental re-exports of internal
 * helpers don't leak through. Update the expected lists when the spec
 * changes; keep them sorted alphabetically for readable diffs.
 */

import { describe, it, expect } from "bun:test";
import * as common from "../common/index.js";
import * as client from "../client/index.js";
import * as server from "../server/index.js";

describe("arkd public barrels", () => {
  it("common surface", () => {
    expect(Object.keys(common).sort()).toEqual([
      "AUTH_EXEMPT_PATHS",
      "ArkdClientError",
      "ArkdClientTransportError",
      "DEFAULT_PORT",
      "SAFE_TMUX_NAME_RE",
      "SUBSCRIBED_ACK",
      "VERSION",
      "requireSafeTmuxName",
    ]);
  });

  it("client surface", () => {
    expect(Object.keys(client).sort()).toEqual(["ArkdClient", "ArkdClientError", "ArkdClientTransportError"]);
  });

  it("server surface", () => {
    expect(Object.keys(server).sort()).toEqual(["PathConfinementError", "VERSION", "startArkd"]);
  });
});
