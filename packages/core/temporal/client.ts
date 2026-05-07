import { Connection, Client } from "@temporalio/client";
import type { TemporalConfig } from "../config/types.js";

let _client: Client | null = null;

export async function getTemporalClient(cfg: TemporalConfig): Promise<Client> {
  if (_client) return _client;
  const connection = await Connection.connect({ address: cfg.serverUrl });
  _client = new Client({ connection, namespace: cfg.namespace });
  return _client;
}

export async function closeTemporalClient(): Promise<void> {
  if (_client) {
    await _client.connection.close();
    _client = null;
  }
}
