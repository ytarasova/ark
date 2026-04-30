import { describe, expect, test } from "bun:test";
import { requireMetadata, RequiredMetadataMissing } from "../placement-types.js";

describe("requireMetadata", () => {
  test("passes when all keys present", () => {
    expect(() =>
      requireMetadata({ name: "X", type: "ssh-private-key", metadata: { host: "bitbucket.org" } }, ["host"]),
    ).not.toThrow();
  });
  test("throws RequiredMetadataMissing when keys missing", () => {
    expect(() => requireMetadata({ name: "X", type: "ssh-private-key", metadata: {} }, ["host"])).toThrow(
      RequiredMetadataMissing,
    );
  });
  test("error message lists all missing keys", () => {
    try {
      requireMetadata({ name: "X", type: "ssh-private-key", metadata: {} }, ["host", "port"]);
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeInstanceOf(RequiredMetadataMissing);
      expect(e.secretName).toBe("X");
      expect(e.missing).toEqual(["host", "port"]);
      expect(e.message).toContain("host");
      expect(e.message).toContain("port");
    }
  });
});
