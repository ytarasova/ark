import React, { useEffect, useState, useRef } from "react";
import { ArkClientContext } from "../hooks/useArkClient.js";
import { ArkClient } from "../../protocol/client.js";
import { ArkServer } from "../../server/index.js";
import { registerAllHandlers } from "../../server/register.js";
import { getApp } from "../../core/app.js";
import { createWebSocketTransport } from "../../protocol/transport.js";
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
  /** Remote control plane URL. When set, connects via WebSocket instead of in-process. */
  serverUrl?: string;
  /** Auth token for remote server. */
  token?: string;
}

export function ArkClientProvider({ children, onReady, serverUrl, token }: Props) {
  const [client, setClient] = useState<ArkClient | null>(null);
  const serverRef = useRef<ArkServer | null>(null);

  useEffect(() => {
    let ark: ArkClient;

    if (serverUrl) {
      // Remote mode: connect to control plane via WebSocket
      const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
      const { transport, ready } = createWebSocketTransport(wsUrl, { token });

      ark = new ArkClient(transport);
      ready
        .then(() => ark.initialize({ subscribe: ["**"] }))
        .then(() => {
          setClient(ark);
          onReady?.();
        })
        .catch((err) => {
          console.error(`Failed to connect to remote server: ${err.message}`);
        });
    } else {
      // Local mode: in-process server
      const server = new ArkServer();
      registerAllHandlers(server.router, getApp());
      serverRef.current = server;

      const { clientTransport, serverTransport } = createInMemoryPair();
      server.addConnection(serverTransport);

      ark = new ArkClient(clientTransport);
      ark.initialize({ subscribe: ["**"] }).then(() => {
        setClient(ark);
        onReady?.();
      });
    }

    return () => { ark.close(); };
  }, [serverUrl]);

  if (!client) return null;

  return (
    <ArkClientContext.Provider value={client}>
      {children}
    </ArkClientContext.Provider>
  );
}
