/**
 * Optional telemetry — tracks usage events for improving Ark.
 * Disabled by default. Enable via ARK_TELEMETRY=1 or config.
 * All data is anonymized (no PII, no session content).
 */

export interface TelemetryEvent {
  event: string;
  properties?: Record<string, string | number | boolean>;
  timestamp: string;
}

let _enabled = process.env.ARK_TELEMETRY === "1";
let _buffer: TelemetryEvent[] = [];
const MAX_BUFFER = 100;

export function isTelemetryEnabled(): boolean { return _enabled; }
export function enableTelemetry(): void { _enabled = true; }
export function disableTelemetry(): void { _enabled = false; }

/** Track a telemetry event. No-op when disabled. */
export function track(event: string, properties?: Record<string, string | number | boolean>): void {
  if (!_enabled) return;
  _buffer.push({
    event,
    properties,
    timestamp: new Date().toISOString(),
  });
  if (_buffer.length > MAX_BUFFER) _buffer.shift();
}

/** Get buffered events (for testing or batch sending). */
export function getBuffer(): TelemetryEvent[] { return [..._buffer]; }

/** Clear the event buffer. */
export function clearBuffer(): void { _buffer = []; }

/** Flush events (placeholder for actual send). */
export async function flush(): Promise<void> {
  if (!_enabled || _buffer.length === 0) return;
  // TODO: Send to telemetry endpoint when configured
  _buffer = [];
}
