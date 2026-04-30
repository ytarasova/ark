import { describe, expect, test } from "bun:test";
import type { SecretRef, SecretType } from "../types.js";

describe("SecretType", () => {
  test("union includes the four v1 types", () => {
    const types: SecretType[] = ["env-var", "ssh-private-key", "generic-blob", "kubeconfig"];
    expect(types.length).toBe(4);
  });

  test("SecretRef has type and metadata fields", () => {
    const ref: SecretRef = {
      tenant_id: "t",
      name: "FOO",
      type: "env-var",
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(ref.type).toBe("env-var");
    expect(ref.metadata).toEqual({});
  });
});
