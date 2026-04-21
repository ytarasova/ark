/**
 * Tests for the blob (multi-file) surface on AwsSecretsProvider.
 *
 * Uses a mock SSMClient that records every command and fakes the
 * parameter-store behaviour just well enough to exercise the round-trip.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { AwsSecretsProvider } from "../aws-provider.js";
import { GetParametersByPathCommand, PutParameterCommand, DeleteParametersCommand } from "@aws-sdk/client-ssm";

/**
 * Fake SSM: stores parameters in an in-memory map and handles the subset
 * of commands our blob surface uses. Deliberately doesn't implement the
 * string-secret commands -- those already have their own test coverage.
 */
class FakeSsm {
  params = new Map<string, string>();
  calls: Array<{ command: string; input: any }> = [];

  async send(command: any): Promise<any> {
    const name = command?.constructor?.name ?? "Unknown";
    const input = command?.input ?? {};
    this.calls.push({ command: name, input });
    if (command instanceof PutParameterCommand) {
      if (!input.Overwrite && this.params.has(input.Name)) {
        throw { name: "ParameterAlreadyExists" };
      }
      this.params.set(input.Name, input.Value);
      return { Version: 1 };
    }
    if (command instanceof GetParametersByPathCommand) {
      const prefix = input.Path as string;
      const recursive = input.Recursive as boolean;
      const out: Array<{ Name: string; Value: string }> = [];
      for (const [k, v] of this.params) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (!recursive && rest.includes("/")) continue;
        out.push({ Name: k, Value: v });
      }
      return { Parameters: out };
    }
    if (command instanceof DeleteParametersCommand) {
      const names = input.Names as string[];
      for (const n of names) this.params.delete(n);
      return {};
    }
    throw new Error(`FakeSsm: no handler for ${name}`);
  }
}

let client: FakeSsm;
let p: AwsSecretsProvider;
beforeEach(() => {
  client = new FakeSsm();
  p = new AwsSecretsProvider({ region: "us-east-1", client: client as any });
});

function decodeBase64Param(params: Map<string, string>, path: string): string {
  const v = params.get(path);
  if (!v) throw new Error(`missing param ${path}`);
  return Buffer.from(v, "base64").toString("utf-8");
}

describe("AwsSecretsProvider blobs", () => {
  it("writes each file as a SecureString under /ark/<tenant>/blobs/<name>/<file>", async () => {
    await p.setBlob("acme", "claude-subscription", {
      ".credentials.json": "CRED",
      ".claude.json": "{}",
    });
    expect(client.params.has("/ark/acme/blobs/claude-subscription/.credentials.json")).toBe(true);
    expect(client.params.has("/ark/acme/blobs/claude-subscription/.claude.json")).toBe(true);
    expect(decodeBase64Param(client.params, "/ark/acme/blobs/claude-subscription/.credentials.json")).toBe("CRED");

    const put = client.calls.find((c) => c.command === "PutParameterCommand");
    expect(put!.input.Type).toBe("SecureString");
    expect(put!.input.Overwrite).toBe(true);
  });

  it("round-trips set / get / listBlobs / deleteBlob", async () => {
    const files = { a: "ONE", b: "TWO", c: "THREE" };
    await p.setBlob("t1", "blobby", files);

    expect(await p.listBlobs("t1")).toEqual(["blobby"]);

    const blob = await p.getBlob("t1", "blobby");
    expect(blob).not.toBeNull();
    const decoder = new TextDecoder();
    expect(decoder.decode(blob!.a)).toBe("ONE");
    expect(decoder.decode(blob!.b)).toBe("TWO");
    expect(decoder.decode(blob!.c)).toBe("THREE");

    const removed = await p.deleteBlob("t1", "blobby");
    expect(removed).toBe(true);
    expect(await p.listBlobs("t1")).toEqual([]);
    expect(await p.getBlob("t1", "blobby")).toBeNull();
    expect(await p.deleteBlob("t1", "blobby")).toBe(false);
  });

  it("set replaces prior blob contents -- stale files get deleted", async () => {
    await p.setBlob("t1", "creds", { a: "one", b: "two" });
    await p.setBlob("t1", "creds", { a: "oneprime" });
    expect(client.params.has("/ark/t1/blobs/creds/b")).toBe(false);
    expect(decodeBase64Param(client.params, "/ark/t1/blobs/creds/a")).toBe("oneprime");
  });

  it("blob namespace is isolated from the string-secret namespace", async () => {
    // A string secret at /ark/t1/MYSTRING shouldn't appear in listBlobs.
    client.params.set("/ark/t1/MYSTRING", "somevalue");
    await p.setBlob("t1", "blobby", { a: "hi" });
    const blobs = await p.listBlobs("t1");
    expect(blobs).toEqual(["blobby"]);
  });

  it("isolates tenants", async () => {
    await p.setBlob("a", "x", { f: "A" });
    await p.setBlob("b", "x", { f: "B" });
    expect(new TextDecoder().decode((await p.getBlob("a", "x"))!.f)).toBe("A");
    expect(new TextDecoder().decode((await p.getBlob("b", "x"))!.f)).toBe("B");
    await p.deleteBlob("a", "x");
    expect(await p.getBlob("a", "x")).toBeNull();
    expect(new TextDecoder().decode((await p.getBlob("b", "x"))!.f)).toBe("B");
  });

  it("validates blob names", async () => {
    await expect(p.setBlob("t1", "BadName", { a: "x" })).rejects.toThrow(/Invalid blob name/);
    await expect(p.getBlob("t1", "B A D")).rejects.toThrow(/Invalid blob name/);
  });
});
