import React, { useEffect, useState, useRef, useCallback } from "react";
import { ArkClientContext } from "../hooks/useArkClient.js";
import { ArkClient } from "../../protocol/client.js";
import { ArkServer } from "../../server/index.js";
import { registerAllHandlers } from "../../server/register.js";
import { createWebSocketTransport } from "../../protocol/transport.js";
import type { AppContext } from "../../core/app.js";
import type { Transport } from "../../protocol/transport.js";
import type { JsonRpcMessage } from "../../protocol/types.js";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

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
  /** Remote control plane or daemon WS URL. Connects via WebSocket instead of in-process. */
  serverUrl?: string;
  /** Auth token for remote server. */
  token?: string;
  /** AppContext for local in-process mode. Passed explicitly -- no getApp() calls. */
  app?: AppContext;
}

/** Context for connection status -- components can show daemon connectivity. */
export const ConnectionStatusContext = React.createContext<ConnectionStatus>("connecting");

export function ArkClientProvider({ children, onReady, serverUrl, token, app }: Props) {
  const [client, setClient] = useState<ArkClient | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const serverRef = useRef<ArkServer | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const unmountedRef = useRef(false);

  const connectWs = useCallback((wsUrl: string, authToken?: string) => {
    if (unmountedRef.current) return;
    setConnectionStatus(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");

    const { transport, ready } = createWebSocketTransport(wsUrl, {
      token: authToken,
      onDisconnect: () => {
        if (!unmountedRef.current) {
          setConnectionStatus("disconnected");
          scheduleReconnect(wsUrl, authToken);
        }
      },
    });

    const ark = new ArkClient(transport);

    ready
      .then(() => ark.initialize({ subscribe: ["**"] }))
      .then(() => {
        if (unmountedRef.current) { ark.close(); return; }
        reconnectAttemptRef.current = 0;
        setConnectionStatus("connected");
        setClient(ark);
        onReady?.();
      })
      .catch(() => {
        if (unmountedRef.current) return;
        scheduleReconnect(wsUrl, authToken);
      });

    return ark;
  }, [onReady]);

  const scheduleReconnect = useCallback((wsUrl: string, authToken?: string) => {
    if (unmountedRef.current) return;
    const attempt = reconnectAttemptRef.current++;
    // Exponential backoff: 1s, 2s, 4s, 8s, ... max 30s
    const delayMs = Math.min(1000 * Math.pow(2, attempt), 30000);
    setConnectionStatus("reconnecting");

    reconnectTimerRef.current = setTimeout(() => {
      if (!unmountedRef.current) {
        connectWs(wsUrl, authToken);
      }
    }, delayMs);
  }, [connectWs]);

  useEffect(() => {
    unmountedRef.current = false;
    let ark: ArkClient | undefined;

    if (serverUrl) {
      // Remote / daemon mode: connect via WebSocket
      const wsUrl = serverUrl.startsWith("ws://") || serverUrl.startsWith("wss://")
        ? serverUrl
        : serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";

      ark = connectWs(wsUrl, token);
    } else if (app) {
      // Local mode: in-process server backed by the provided AppContext
      const server = new ArkServer();
      registerAllHandlers(server.router, app);
      serverRef.current = server;

      const { clientTransport, serverTransport } = createInMemoryPair();
      server.addConnection(serverTransport);

      ark = new ArkClient(clientTransport);
      ark.initialize({ subscribe: ["**"] }).then(() => {
        setConnectionStatus("connected");
        setClient(ark!);
        onReady?.();
      });
    } else {
      console.error("ArkClientProvider: either serverUrl or app must be provided");
      return;
    }

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (ark) ark.close();
    };
  }, [serverUrl, app]);

  if (!client) return null;

  return (
    <ConnectionStatusContext.Provider value={connectionStatus}>
      <ArkClientContext.Provider value={client}>
        {children}
      </ArkClientContext.Provider>
    </ConnectionStatusContext.Provider>
  );
}
