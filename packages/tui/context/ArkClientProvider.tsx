import React, { useEffect, useState, useRef } from "react";
import { ArkClientContext } from "../hooks/useArkClient.js";
import { ArkClient } from "../../protocol/client.js";
import { createWebSocketTransport } from "../../protocol/transport.js";
import type { ConnectionStatus } from "../../protocol/transport.js";
import type { Transport } from "../../protocol/transport.js";
import type { JsonRpcMessage } from "../../protocol/types.js";

function createInMemoryPair(): { clientTransport: Transport; serverTransport: Transport } {
  let clientHandler: (msg: JsonRpcMessage) => void = () => {};
  let serverHandler: (msg: JsonRpcMessage) => void = () => {};

  const clientTransport: Transport = {
    send(msg) { queueMicrotask(() => serverHandler(msg)); },
    onMessage(h) { clientHandler = h; },
    close() {},
  };

  const serverTransport: Transport = {
    send(msg) { queueMicrotask(() => clientHandler(msg)); },
    onMessage(h) { serverHandler = h; },
    close() {},
  };

  return { clientTransport, serverTransport };
}

interface Props {
  children: React.ReactNode;
  onReady?: () => void;
  /** Remote or local daemon URL. When set, connects via WebSocket. */
  serverUrl?: string;
  /** Auth token for remote server. */
  token?: string;
  /** AppContext for embedded in-process mode (ARK_TUI_EMBEDDED=1 fallback). */
  app?: any;
  /** Called when connection status changes (for daemon/remote mode). */
  onConnectionStatus?: (status: ConnectionStatus) => void;
}

export function ArkClientProvider({ children, onReady, serverUrl, token, app, onConnectionStatus }: Props) {
  const [client, setClient] = useState<ArkClient | null>(null);
  const arkRef = useRef<ArkClient | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (serverUrl) {
      // Daemon or remote mode: connect via WebSocket with reconnection
      const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
      const { transport, ready } = createWebSocketTransport(wsUrl, {
        token,
        reconnect: true,
        onStatus: (status) => {
          if (!cancelled) {
            arkRef.current?.setConnectionStatus(status);
            onConnectionStatus?.(status);
          }
        },
      });

      const ark = new ArkClient(transport);
      arkRef.current = ark;
      ready
        .then(() => ark.initialize({ subscribe: ["**"] }))
        .then(() => {
          if (!cancelled) {
            setClient(ark);
            onReady?.();
          }
        })
        .catch((err) => {
          if (!cancelled) console.error(`Failed to connect to server: ${err.message}`);
        });
    } else if (app) {
      // Embedded mode: in-process server (dynamic import to avoid static dependency)
      (async () => {
        if (cancelled) return;
        const { ArkServer } = await import("../../server/index.js");
        const { registerAllHandlers } = await import("../../server/register.js");

        if (cancelled) return;
        const server = new ArkServer();
        registerAllHandlers(server.router, app);

        const { clientTransport, serverTransport } = createInMemoryPair();
        server.addConnection(serverTransport);

        const ark = new ArkClient(clientTransport);
        arkRef.current = ark;
        await ark.initialize({ subscribe: ["**"] });
        if (!cancelled) {
          setClient(ark);
          onReady?.();
        }
      })().catch((err) => {
        if (!cancelled) console.error(`ArkClientProvider init error: ${err.message}`);
      });
    } else {
      console.error("ArkClientProvider: either serverUrl or app must be provided");
      return;
    }

    return () => {
      cancelled = true;
      try { arkRef.current?.close(); } catch { /* cleanup is best-effort */ }
      arkRef.current = null;
    };
  }, [serverUrl, app]);

  if (!client) return null;

  return (
    <ArkClientContext.Provider value={client}>
      {children}
    </ArkClientContext.Provider>
  );
}
