/**
 * Tests for the AWS SSM Parameter Store secrets provider.
 *
 * We inject a mock `SSMClient` that records every `send()` call plus its
 * command shape. Nothing actually talks to AWS.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { AwsSecretsProvider, decodeDescriptionEnvelope } from "../aws-provider.js";
import {
  GetParameterCommand,
  GetParametersCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from "@aws-sdk/client-ssm";

type Call = { command: string; input: Record<string, unknown> };

/** Minimal SSMClient stand-in. The real client has a `send(command)` method. */
class MockSsmClient {
  calls: Call[] = [];
  responders: {
    GetParameter?: (input: any) => any;
    GetParameters?: (input: any) => any;
    GetParametersByPath?: (input: any) => any;
    PutParameter?: (input: any) => any;
    DeleteParameter?: (input: any) => any;
  } = {};

  async send(command: any): Promise<any> {
    const name = command?.constructor?.name ?? "Unknown";
    const input = command?.input ?? {};
    this.calls.push({ command: name, input });
    if (command instanceof GetParameterCommand) {
      return this.responders.GetParameter?.(input) ?? { Parameter: undefined };
    }
    if (command instanceof GetParametersCommand) {
      return this.responders.GetParameters?.(input) ?? { Parameters: [] };
    }
    if (command instanceof GetParametersByPathCommand) {
      return this.responders.GetParametersByPath?.(input) ?? { Parameters: [] };
    }
    if (command instanceof PutParameterCommand) {
      return this.responders.PutParameter?.(input) ?? { Version: 1 };
    }
    if (command instanceof DeleteParameterCommand) {
      return this.responders.DeleteParameter?.(input) ?? {};
    }
    throw new Error(`MockSsmClient: no handler for ${name}`);
  }
}

let client: MockSsmClient;
let p: AwsSecretsProvider;
beforeEach(() => {
  client = new MockSsmClient();
  p = new AwsSecretsProvider({ region: "us-east-1", client: client as unknown as any });
});

describe("AwsSecretsProvider", () => {
  it("writes under /ark/<tenant>/<NAME> as a SecureString with the configured KMS key", async () => {
    const pWithKms = new AwsSecretsProvider({
      region: "us-east-1",
      kmsKeyId: "alias/ark-secrets",
      client: client as unknown as any,
    });
    await pWithKms.set("acme", "ANTHROPIC_API_KEY", "sk-xyz", { description: "prod" });
    expect(client.calls).toHaveLength(1);
    const put = client.calls[0];
    expect(put.command).toBe("PutParameterCommand");
    expect(put.input).toMatchObject({
      Name: "/ark/acme/ANTHROPIC_API_KEY",
      Value: "sk-xyz",
      Type: "SecureString",
      Overwrite: true,
      Tier: "Standard",
      KeyId: "alias/ark-secrets",
    });
    // Description is now a JSON envelope -- decode and verify the intent.
    const envelope = decodeDescriptionEnvelope(put.input.Description as string);
    expect(envelope.description).toBe("prod");
    expect(envelope.type).toBe("env-var");
    expect(envelope.metadata).toEqual({});
  });

  it("paginates list across NextToken pages and returns refs only", async () => {
    let page = 0;
    client.responders.GetParametersByPath = (input: any) => {
      expect(input.Path).toBe("/ark/acme/");
      expect(input.WithDecryption).toBe(false);
      if (page++ === 0) {
        return {
          Parameters: [{ Name: "/ark/acme/FOO", LastModifiedDate: new Date("2025-01-01T00:00:00Z") }],
          NextToken: "tok-1",
        };
      }
      expect(input.NextToken).toBe("tok-1");
      return { Parameters: [{ Name: "/ark/acme/BAR", LastModifiedDate: new Date("2025-02-01T00:00:00Z") }] };
    };
    const refs = await p.list("acme");
    expect(refs.map((r) => r.name)).toEqual(["BAR", "FOO"]);
    expect(refs[0].tenant_id).toBe("acme");
    // Ensure values never appear on refs
    for (const r of refs) {
      expect((r as unknown as Record<string, unknown>).value).toBeUndefined();
    }
    // Two pages -> two calls
    expect(client.calls.filter((c) => c.command === "GetParametersByPathCommand")).toHaveLength(2);
  });

  it("resolveMany issues a single GetParameters (not N GetParameter calls)", async () => {
    client.responders.GetParameters = (input: any) => {
      expect(input.WithDecryption).toBe(true);
      expect((input.Names as string[]).sort()).toEqual(["/ark/acme/BAR", "/ark/acme/FOO"]);
      return {
        Parameters: [
          { Name: "/ark/acme/FOO", Value: "fv" },
          { Name: "/ark/acme/BAR", Value: "bv" },
        ],
      };
    };
    const env = await p.resolveMany("acme", ["FOO", "BAR"]);
    expect(env).toEqual({ FOO: "fv", BAR: "bv" });
    const cmds = client.calls.map((c) => c.command);
    expect(cmds).toEqual(["GetParametersCommand"]);
  });

  it("resolveMany throws with the full missing list when any names are absent", async () => {
    client.responders.GetParameters = () => ({
      Parameters: [{ Name: "/ark/acme/FOO", Value: "fv" }],
    });
    let err: Error | null = null;
    try {
      await p.resolveMany("acme", ["FOO", "BAR", "BAZ"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("BAR");
    expect(err!.message).toContain("BAZ");
    expect(err!.message).not.toContain("fv");
  });

  it("get returns null on ParameterNotFound, throws on other errors", async () => {
    client.responders.GetParameter = () => {
      const e: any = new Error("no such param");
      e.name = "ParameterNotFound";
      throw e;
    };
    expect(await p.get("acme", "FOO")).toBeNull();

    client.responders.GetParameter = () => {
      throw new Error("boom");
    };
    await expect(p.get("acme", "FOO")).rejects.toThrow(/boom/);
  });

  it("delete returns false on ParameterNotFound, true on success", async () => {
    client.responders.DeleteParameter = () => ({});
    expect(await p.delete("acme", "FOO")).toBe(true);

    client.responders.DeleteParameter = () => {
      const e: any = new Error("no such param");
      e.name = "ParameterNotFound";
      throw e;
    };
    expect(await p.delete("acme", "MISSING")).toBe(false);
  });

  it("rejects invalid names at the surface", async () => {
    await expect(p.set("acme", "lower", "v")).rejects.toThrow(/Invalid secret name|non-empty/);
    await expect(p.get("acme", "lower")).rejects.toThrow(/Invalid secret name|non-empty/);
    await expect(p.delete("acme", "lower")).rejects.toThrow(/Invalid secret name|non-empty/);
    await expect(p.resolveMany("acme", ["OK", "bad-name"])).rejects.toThrow(/Invalid secret name|non-empty/);
  });
});
