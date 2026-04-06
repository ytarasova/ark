/**
 * CLI singleton ArkClient — in-process server with in-memory transport.
 *
 * Same pattern as ArkClientProvider.tsx in the TUI, adapted for non-React use.
 */

import { ArkClient } from "../protocol/client.js";
import { ArkServer } from "../server/index.js";
import { registerAllHandlers } from "../server/register.js";
import type { Transport } from "../protocol/transport.js";
import type { JsonRpcMessage } from "../protocol/types.js";

let _client: ArkClient | null = null;
let _server: ArkServer | null = null;

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

export async function getArkClient(): Promise<ArkClient> {
  if (_client) return _client;

  _server = new ArkServer();
  registerAllHandlers(_server.router);

  const { clientTransport, serverTransport } = createInMemoryPair();
  _server.addConnection(serverTransport);

  const client = new ArkClient(clientTransport);
  await client.initialize({ subscribe: ["**"] });
  _client = client;
  return _client;
}

export function closeArkClient(): void {
  if (_client) {
    _client.close();
    _client = null;
  }
  _server = null;
}
