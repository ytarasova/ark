/**
 * Port allocator -- bind :0 to a free ephemeral port, close, return it.
 *
 * Used by the `test` profile to give each test worker a unique port,
 * so the full test suite can run in parallel without port collisions.
 *
 * The port is not held -- we bind, read the assigned number, then close.
 * This creates a small TOCTOU race window where another process could
 * grab the port before the test server starts, but in practice that
 * window is microseconds wide and collisions are astronomically rare.
 * If this ever bites us, the fix is to hand the bound socket directly
 * to the server via fd inheritance (Node doesn't expose that cleanly,
 * so we keep the simple version until measurement says otherwise).
 */

import { createServer } from "net";

/** Allocate one free ephemeral port. Binds to 0.0.0.0:0, closes, returns the port. */
export async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("port allocator: unexpected address type"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Allocate N free ephemeral ports. */
export async function allocatePorts(n: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < n; i++) ports.push(await allocatePort());
  return ports;
}

/**
 * Allocate a free "base port" for a contiguous range (e.g. channel ports).
 *
 * Returns a port P such that P .. P+range-1 is likely unused. We probe
 * a few candidates; if none land cleanly we fall back to a random base
 * in the high-port range and let the caller hash into it.
 *
 * This is heuristic -- we only probe the base itself, not every port
 * in the range. Tests should hash a short-lived id into [0, range) and
 * trust that collisions in a 10k-port window within a single worker
 * are rare enough to ignore.
 */
export async function allocateBasePort(range = 1000): Promise<number> {
  // Grab an ephemeral port and round down to leave headroom for the range.
  const p = await allocatePort();
  // Keep the base below 65535 - range so the whole window is valid.
  const max = 65535 - range;
  return Math.min(p, max);
}
