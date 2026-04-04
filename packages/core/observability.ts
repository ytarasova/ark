/**
 * Observability hooks — send agent events to external platforms.
 * Supports Laminar, Langfuse, or custom HTTP endpoints.
 */

export interface ObservabilityConfig {
  enabled: boolean;
  endpoint?: string;       // HTTP endpoint to POST events to
  apiKey?: string;         // Auth header value
  provider?: "laminar" | "langfuse" | "custom";
}

export interface ObservabilityEvent {
  type: "session_start" | "session_end" | "tool_call" | "agent_turn" | "error";
  sessionId: string;
  data: Record<string, unknown>;
  timestamp: string;
  duration_ms?: number;
}

let _config: ObservabilityConfig = { enabled: false };
let _buffer: ObservabilityEvent[] = [];

export function configureObservability(config: ObservabilityConfig): void {
  _config = config;
}

export function getObservabilityConfig(): ObservabilityConfig {
  return { ..._config };
}

/** Record an observability event. Batched and flushed periodically. */
export function recordEvent(event: Omit<ObservabilityEvent, "timestamp">): void {
  if (!_config.enabled) return;
  _buffer.push({ ...event, timestamp: new Date().toISOString() });
  if (_buffer.length >= 50) flush();
}

/** Flush buffered events to the configured endpoint. */
export async function flush(): Promise<void> {
  if (!_config.enabled || !_config.endpoint || _buffer.length === 0) return;
  const events = [..._buffer];
  _buffer = [];

  try {
    await fetch(_config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ..._config.apiKey ? { Authorization: `Bearer ${_config.apiKey}` } : {},
      },
      body: JSON.stringify({ events }),
    });
  } catch (e: any) {
    console.error("observability: flush failed:", e?.message ?? e);
    // Re-buffer failed events (up to limit)
    _buffer.unshift(...events.slice(0, 50 - _buffer.length));
  }
}

/** Get buffered events (for testing). */
export function getEventBuffer(): ObservabilityEvent[] { return [..._buffer]; }

/** Clear the buffer and config. */
export function resetObservability(): void {
  _config = { enabled: false };
  _buffer = [];
}
