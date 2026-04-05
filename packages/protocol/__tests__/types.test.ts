import { describe, it, expect } from "bun:test";
import {
  createRequest, createResponse, createErrorResponse, createNotification,
  parseMessage, isRequest, isResponse, isNotification, isError,
  ErrorCodes,
} from "../types.js";

describe("JSON-RPC message creation", () => {
  it("createRequest produces valid request", () => {
    const req = createRequest(1, "session/list", { limit: 10 });
    expect(req.jsonrpc).toBe("2.0");
    expect(req.id).toBe(1);
    expect(req.method).toBe("session/list");
    expect(req.params).toEqual({ limit: 10 });
  });

  it("createResponse wraps result", () => {
    const res = createResponse(1, { sessions: [] });
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.result).toEqual({ sessions: [] });
  });

  it("createErrorResponse wraps error", () => {
    const err = createErrorResponse(1, ErrorCodes.SESSION_NOT_FOUND, "Not found");
    expect(err.jsonrpc).toBe("2.0");
    expect(err.id).toBe(1);
    expect(err.error.code).toBe(-32002);
    expect(err.error.message).toBe("Not found");
  });

  it("createNotification has no id", () => {
    const n = createNotification("session/updated", { session: {} });
    expect(n.jsonrpc).toBe("2.0");
    expect(n.method).toBe("session/updated");
    expect((n as any).id).toBeUndefined();
  });
});

describe("message parsing", () => {
  it("parseMessage roundtrips a request", () => {
    const req = createRequest(1, "session/list", {});
    const json = JSON.stringify(req);
    const parsed = parseMessage(json);
    expect(isRequest(parsed)).toBe(true);
    expect(parsed.method).toBe("session/list");
  });

  it("parseMessage rejects invalid JSON", () => {
    expect(() => parseMessage("not json")).toThrow();
  });

  it("classifies requests, responses, notifications, errors", () => {
    expect(isRequest(createRequest(1, "test", {}))).toBe(true);
    expect(isResponse(createResponse(1, {}))).toBe(true);
    expect(isNotification(createNotification("test", {}))).toBe(true);
    expect(isError(createErrorResponse(1, -32600, "bad"))).toBe(true);
  });
});

describe("ErrorCodes", () => {
  it("has standard JSON-RPC codes", () => {
    expect(ErrorCodes.INVALID_REQUEST).toBe(-32600);
    expect(ErrorCodes.METHOD_NOT_FOUND).toBe(-32601);
    expect(ErrorCodes.INVALID_PARAMS).toBe(-32602);
    expect(ErrorCodes.INTERNAL_ERROR).toBe(-32603);
  });

  it("has Ark-specific codes", () => {
    expect(ErrorCodes.NOT_INITIALIZED).toBe(-32001);
    expect(ErrorCodes.SESSION_NOT_FOUND).toBe(-32002);
    expect(ErrorCodes.EXECUTOR_ERROR).toBe(-32003);
    expect(ErrorCodes.GATE_NOT_PENDING).toBe(-32004);
    expect(ErrorCodes.OVERLOADED).toBe(-32005);
  });
});
