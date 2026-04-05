/**
 * Optional telemetry — tracks usage events for improving Ark.
 * Disabled by default. Enable via config or ARK_TELEMETRY=1.
 */

export interface TelemetryEvent {
  event: string;
  properties?: Record<string, string | number | boolean>;
  timestamp: string;
}

export interface TelemetryConfig {
  enabled: boolean;
  endpoint?: string;
}

let _config: TelemetryConfig = { enabled: process.env.ARK_TELEMETRY === "1" };
let _buffer: TelemetryEvent[] = [];
const MAX_BUFFER = 100;

export function configureTelemetry(config: TelemetryConfig): void { _config = config; }
export function isTelemetryEnabled(): boolean { return _config.enabled; }
export function enableTelemetry(): void { _config.enabled = true; }
export function disableTelemetry(): void { _config.enabled = false; }

export function track(event: string, properties?: Record<string, string | number | boolean>): void {
  if (!_config.enabled) return;
  _buffer.push({ event, properties, timestamp: new Date().toISOString() });
  if (_buffer.length > MAX_BUFFER) _buffer.shift();
}

export function getBuffer(): TelemetryEvent[] { return [..._buffer]; }
export function clearBuffer(): void { _buffer = []; }

export function resetTelemetry(): void {
  _config = { enabled: false };
  _buffer = [];
}

export async function flush(): Promise<void> {
  if (!_config.enabled || _buffer.length === 0) return;
  const events = [..._buffer];
  _buffer = [];
  if (!_config.endpoint) return;
  try {
    await fetch(_config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
  } catch { /* fire-and-forget */ }
}
