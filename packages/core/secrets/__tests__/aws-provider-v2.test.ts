import { describe, expect, test } from "bun:test";
import { encodeDescriptionEnvelope, decodeDescriptionEnvelope } from "../aws-provider.js";

describe("Description envelope", () => {
  test("encodes JSON envelope with description, type, metadata", () => {
    const out = encodeDescriptionEnvelope({
      description: "bb",
      type: "ssh-private-key",
      metadata: { host: "bitbucket.org" },
    });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ description: "bb", type: "ssh-private-key", metadata: { host: "bitbucket.org" } });
  });

  test("decodes JSON envelope", () => {
    const env = decodeDescriptionEnvelope(
      '{"description":"bb","type":"ssh-private-key","metadata":{"host":"bitbucket.org"}}',
    );
    expect(env.type).toBe("ssh-private-key");
    expect(env.metadata).toEqual({ host: "bitbucket.org" });
  });

  test("decodes legacy plain-text Description as description only", () => {
    const env = decodeDescriptionEnvelope("legacy plain text description");
    expect(env.description).toBe("legacy plain text description");
    expect(env.type).toBe("env-var"); // default
    expect(env.metadata).toEqual({}); // default
  });

  test("decodes empty/missing as defaults", () => {
    expect(decodeDescriptionEnvelope(undefined).type).toBe("env-var");
    expect(decodeDescriptionEnvelope("").type).toBe("env-var");
  });
});
