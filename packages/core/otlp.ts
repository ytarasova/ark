/**
 * Minimal OTLP JSON exporter — session and stage spans.
 * No OpenTelemetry SDK dependency. Posts to any OTLP HTTP collector.
 */

import { randomBytes } from "crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface OtlpConfig {
  enabled: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: Record<string, string | number | boolean>;
}

// ── State ──────────────────────────────────────────────────────────────────

let _config: OtlpConfig = { enabled: false };
const _active = new Map<string, OtlpSpan>();
let _buffer: OtlpSpan[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;

// ── Config ─────────────────────────────────────────────────────────────────

export function configureOtlp(config: OtlpConfig): void {
  _config = config;
  if (_flushTimer) clearInterval(_flushTimer);
  if (config.enabled && config.endpoint) {
    _flushTimer = setInterval(() => { flushSpans(); }, 30_000);
  }
}

export function resetOtlp(): void {
  _config = { enabled: false };
  _active.clear();
  _buffer = [];
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
}

// ── Span lifecycle ─────────────────────────────────────────────────────────

function genId(): string { return randomBytes(8).toString("hex"); }
function nowNano(): string { return (BigInt(Date.now()) * 1_000_000n).toString(); }

export function startSpan(opts: {
  name: string;
  traceId: string;
  parentSpanId?: string;
  attributes: Record<string, string | number | boolean>;
}): string {
  if (!_config.enabled) return "";

  const span: OtlpSpan = {
    traceId: opts.traceId,
    spanId: genId(),
    parentSpanId: opts.parentSpanId,
    name: opts.name,
    startTimeUnixNano: nowNano(),
    attributes: { ...opts.attributes },
  };
  _active.set(span.spanId, span);
  return span.spanId;
}

export function endSpan(spanId: string, extraAttributes?: Record<string, string | number | boolean>): void {
  if (!spanId) return;
  const span = _active.get(spanId);
  if (!span) return;

  span.endTimeUnixNano = nowNano();
  if (extraAttributes) Object.assign(span.attributes, extraAttributes);
  _active.delete(spanId);
  _buffer.push(span);
}

// ── Buffer access (testing) ────────────────────────────────────────────────

export function getSpanBuffer(): OtlpSpan[] { return [..._buffer]; }

// ── Flush ──────────────────────────────────────────────────────────────────

function formatOtlpJson(spans: OtlpSpan[]): object {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "ark" } },
        ],
      },
      scopeSpans: [{
        scope: { name: "ark.session" },
        spans: spans.map(s => ({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId ?? "",
          name: s.name,
          kind: 1,
          startTimeUnixNano: s.startTimeUnixNano,
          endTimeUnixNano: s.endTimeUnixNano ?? nowNano(),
          attributes: Object.entries(s.attributes).map(([key, value]) => ({
            key,
            value: typeof value === "string" ? { stringValue: value }
              : typeof value === "number" ? { doubleValue: value }
              : { boolValue: value },
          })),
          status: { code: 0 },
        })),
      }],
    }],
  };
}

export async function flushSpans(): Promise<void> {
  if (!_config.enabled || !_config.endpoint || _buffer.length === 0) return;

  const spans = [..._buffer];
  _buffer = [];

  try {
    await fetch(_config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(_config.headers ?? {}),
      },
      body: JSON.stringify(formatOtlpJson(spans)),
    });
  } catch {
    // Fire-and-forget — don't throw or re-buffer
  }
}
