import { describe, it, expect } from "bun:test";
import { JsonlCodec } from "../transport.js";
import { createRequest, createResponse, createNotification } from "../types.js";

describe("JsonlCodec", () => {
  it("encodes a message to JSONL (newline-terminated)", () => {
    const req = createRequest(1, "test", {});
    const line = JsonlCodec.encode(req);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual(req);
  });

  it("decodes a JSONL line to a message", () => {
    const req = createRequest(1, "test", { x: 1 });
    const line = JSON.stringify(req) + "\n";
    const msg = JsonlCodec.decode(line);
    expect(msg).toEqual(req);
  });

  it("decodes line without trailing newline", () => {
    const req = createRequest(1, "test", {});
    const line = JSON.stringify(req);
    const msg = JsonlCodec.decode(line);
    expect(msg).toEqual(req);
  });

  it("splitLines handles partial + complete lines from stream", () => {
    const lines: string[] = [];
    const splitter = JsonlCodec.createLineSplitter((line) => lines.push(line));

    splitter.push('{"jsonrpc":"2.0","id":1,"met');
    expect(lines.length).toBe(0);

    splitter.push('hod":"test"}\n{"jsonrpc":"2.0","id":2');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).id).toBe(1);

    splitter.push(',"method":"test2"}\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]).id).toBe(2);
  });
});
