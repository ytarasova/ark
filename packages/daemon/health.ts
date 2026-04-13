/**
 * Daemon health probe.
 *
 * Verifies a daemon is responsive by opening a WebSocket, sending an
 * "initialize" JSON-RPC request, and checking for a valid response.
 */

/**
 * Check if a daemon at the given WebSocket URL is healthy.
 * Opens a WS connection, sends initialize, expects a response within timeout.
 */
export async function checkDaemonHealth(wsUrl: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* best effort */ }
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => done(false), timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      done(false);
      return;
    }

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }));
      } catch {
        done(false);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
        if (msg.id === 1 && msg.result) {
          done(true);
        }
      } catch {
        done(false);
      }
    };

    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
  });
}
