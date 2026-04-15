/**
 * CLI singleton ArkClient -- in-process server with in-memory transport,
 * or remote WebSocket client when --server / ARK_SERVER is set.
 *
 * Singleton pattern adapted for non-React CLI use.
 */

import { ArkClient } from "../protocol/client.js";
import { ArkServer } from "../server/index.js";
import { registerAllHandlers } from "../server/register.js";
import { getApp } from "../core/app.js";
import { createWebSocketTransport } from "../protocol/transport.js";
import type { Transport } from "../protocol/transport.js";
import type { JsonRpcMessage } from "../protocol/types.js";

let _client: ArkClient | null = null;
let _server: ArkServer | null = null;

/** Remote server URL set via --server or ARK_SERVER env var. */
let _remoteServerUrl: string | undefined;
/** Auth token set via --token or ARK_TOKEN env var. */
let _remoteToken: string | undefined;

/** Called from index.ts to configure remote mode before any commands run. */
export function setRemoteServer(url: string | undefined, token: string | undefined): void {
  _remoteServerUrl = url;
  _remoteToken = token;
}

/** Returns true when operating in remote mode. */
export function isRemoteMode(): boolean {
  return !!(_remoteServerUrl || process.env.ARK_SERVER);
}

function createInMemoryPair(): { clientTransport: Transport; serverTransport: Transport } {
  let clientHandler: (msg: JsonRpcMessage) => void = () => {};
  let serverHandler: (msg: JsonRpcMessage) => void = () => {};

  const clientTransport: Transport = {
    send(msg) {
      queueMicrotask(() => serverHandler(msg));
    },
    onMessage(h) {
      clientHandler = h;
    },
    close() {},
  };

  const serverTransport: Transport = {
    send(msg) {
      queueMicrotask(() => clientHandler(msg));
    },
    onMessage(h) {
      serverHandler = h;
    },
    close() {},
  };

  return { clientTransport, serverTransport };
}

export async function getArkClient(): Promise<ArkClient> {
  if (_client) return _client;

  const serverUrl = _remoteServerUrl || process.env.ARK_SERVER;
  const token = _remoteToken || process.env.ARK_TOKEN;

  if (serverUrl) {
    // Remote mode: connect to existing control plane via WebSocket
    const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    const { transport, ready } = createWebSocketTransport(wsUrl, { token });
    await ready;

    const client = new ArkClient(transport);
    await client.initialize({ subscribe: ["**"] });
    _client = client;
    return _client;
  }

  // Local mode: start server in-process
  _server = new ArkServer();
  registerAllHandlers(_server.router, getApp());

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
