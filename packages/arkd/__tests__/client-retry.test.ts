/**
 * ArkdClient retry-on-transient-transport-error tests.
 *
 * Background: live EC2 dispatch failed mid-`/exec` with
 * `TypeError: The socket connection was closed unexpectedly`. The SSM
 * port-forward and arkd were both verified healthy seconds after the failure
 * via curl, so the failure was a transient socket-pool / port-forward
 * blip rather than a real outage. ArkdClient now retries POST/GET twice
 * (250ms, 1s) on transport-level errors. ArkdClientError (real arkd-side
 * failures with a code) is NOT retried.
 *
 * Strategy: stand up a raw TCP server that closes the socket without
 * writing any HTTP response. fetch() against this surfaces the exact
 * "socket connection was closed unexpectedly" we hit in production.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server, type Socket } from "net";
import { ArkdClient } from "../client/index.js";
import { allocatePort } from "../../core/config/port-allocator.js";

interface Counter {
  count: number;
  failFirstN: number;
}

let tcpServer: Server;
let tcpPort: number;
const counter: Counter = { count: 0, failFirstN: 0 };

beforeAll(async () => {
  tcpPort = await allocatePort();
  await new Promise<void>((resolve) => {
    tcpServer = createServer((sock: Socket) => {
      counter.count++;
      if (counter.count <= counter.failFirstN) {
        // Drop the connection mid-handshake -- fetch sees this as
        // "socket connection was closed unexpectedly".
        sock.destroy();
        return;
      }
      // Write a minimal valid HTTP/1.1 response, close, done.
      const body = JSON.stringify({ status: "ok", version: "test", hostname: "h", platform: "linux" });
      sock.write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      sock.end();
    });
    tcpServer.listen(tcpPort, "127.0.0.1", () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
});

describe("ArkdClient transient-error retry", () => {
  it("retries on socket-close and eventually succeeds", async () => {
    counter.count = 0;
    counter.failFirstN = 1;
    const client = new ArkdClient(`http://127.0.0.1:${tcpPort}`, { requestTimeoutMs: 5_000 });
    const res = await client.health();
    expect(res.status).toBe("ok");
    // 1 dropped + 1 success = 2 attempts.
    expect(counter.count).toBe(2);
  });

  it("retries up to twice (3 total attempts) then gives up", async () => {
    counter.count = 0;
    counter.failFirstN = 99;
    const client = new ArkdClient(`http://127.0.0.1:${tcpPort}`, { requestTimeoutMs: 5_000 });
    await expect(client.health()).rejects.toThrow();
    // initial + 2 retries = 3 attempts max.
    expect(counter.count).toBe(3);
  });

  it("does NOT retry on a real 4xx/5xx response from arkd", async () => {
    // Separate TCP server that returns a clean 400 with ArkdError body.
    const port = await allocatePort();
    let count = 0;
    const srv = createServer((sock: Socket) => {
      count++;
      const body = JSON.stringify({ error: "bad request", code: "BAD_REQ" });
      sock.write(
        `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      sock.end();
    });
    await new Promise<void>((resolve) => srv.listen(port, "127.0.0.1", () => resolve()));
    try {
      const client = new ArkdClient(`http://127.0.0.1:${port}`, { requestTimeoutMs: 5_000 });
      await expect(client.health()).rejects.toThrow(/bad request/);
      expect(count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
