import React, { useEffect, useState, useRef } from "react";
import { ArkClientContext } from "../hooks/useArkClient.js";
import { ArkClient } from "../../protocol/client.js";
import { ArkServer } from "../../server/index.js";
import { registerAllHandlers } from "../../server/register.js";
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
}

export function ArkClientProvider({ children, onReady }: Props) {
  const [client, setClient] = useState<ArkClient | null>(null);
  const serverRef = useRef<ArkServer | null>(null);

  useEffect(() => {
    const server = new ArkServer();
    registerAllHandlers(server.router);
    serverRef.current = server;

    const { clientTransport, serverTransport } = createInMemoryPair();
    server.addConnection(serverTransport);

    const ark = new ArkClient(clientTransport);
    ark.initialize({ subscribe: ["**"] }).then(() => {
      setClient(ark);
      onReady?.();
    });

    return () => { ark.close(); };
  }, []);

  if (!client) return null;

  return (
    <ArkClientContext.Provider value={client}>
      {children}
    </ArkClientContext.Provider>
  );
}
