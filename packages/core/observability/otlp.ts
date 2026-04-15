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

export interface OtlpSpan {
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
    _flushTimer = setInterval(() => {
      flushSpans();
    }, 30_000);
  }
}

export function resetOtlp(): void {
  _config = { enabled: false };
  _active.clear();
  _buffer = [];
  _sessionTraces.clear();
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}

// ── Span lifecycle ─────────────────────────────────────────────────────────

function genId(): string {
  return randomBytes(8).toString("hex");
}
function nowNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

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

export function getSpanBuffer(): OtlpSpan[] {
  return [..._buffer];
}

// ── Flush ──────────────────────────────────────────────────────────────────

function formatOtlpJson(spans: OtlpSpan[]): object {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "ark" } }],
        },
        scopeSpans: [
          {
            scope: { name: "ark.session" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId ?? "",
              name: s.name,
              kind: 1,
              startTimeUnixNano: s.startTimeUnixNano,
              endTimeUnixNano: s.endTimeUnixNano ?? nowNano(),
              attributes: Object.entries(s.attributes).map(([key, value]) => ({
                key,
                value:
                  typeof value === "string"
                    ? { stringValue: value }
                    : typeof value === "number"
                      ? { doubleValue: value }
                      : { boolValue: value },
              })),
              status: { code: 0 },
            })),
          },
        ],
      },
    ],
  };
}

export async function flushSpans(): Promise<void> {
  if (!_config.enabled || _buffer.length === 0) return;
  const spans = [..._buffer];
  _buffer = [];
  if (!_config.endpoint) return;

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

// ── Session-level helpers ──────────────────────────────────────────────────

const _sessionTraces = new Map<string, { traceId: string; sessionSpanId: string; stageSpanId?: string }>();

export function getSessionTraceId(sessionId: string): string | undefined {
  return _sessionTraces.get(sessionId)?.traceId;
}

export function emitSessionSpanStart(
  sessionId: string,
  attrs: {
    flow: string;
    repo?: string;
    agent?: string;
  },
): void {
  const traceId = genId() + genId();
  const spanId = startSpan({
    name: "session",
    traceId,
    attributes: {
      "session.id": sessionId,
      "session.flow": attrs.flow,
      ...(attrs.repo ? { "session.repo": attrs.repo } : {}),
      ...(attrs.agent ? { "session.agent": attrs.agent } : {}),
    },
  });
  _sessionTraces.set(sessionId, { traceId, sessionSpanId: spanId });
}

export function emitSessionSpanEnd(
  sessionId: string,
  attrs: {
    status: string;
    tokens_in?: number;
    tokens_out?: number;
    tokens_cache?: number;
    cost_usd?: number;
    turns?: number;
  },
): void {
  const trace = _sessionTraces.get(sessionId);
  if (!trace) return;
  endSpan(trace.sessionSpanId, {
    "session.status": attrs.status,
    ...(attrs.tokens_in != null ? { "tokens.input": attrs.tokens_in } : {}),
    ...(attrs.tokens_out != null ? { "tokens.output": attrs.tokens_out } : {}),
    ...(attrs.tokens_cache != null ? { "tokens.cache": attrs.tokens_cache } : {}),
    ...(attrs.cost_usd != null ? { "cost.usd": attrs.cost_usd } : {}),
    ...(attrs.turns != null ? { turns: attrs.turns } : {}),
  });
  _sessionTraces.delete(sessionId);
}

export function emitStageSpanStart(
  sessionId: string,
  attrs: {
    stage: string;
    agent?: string;
    gate?: string;
  },
): void {
  const trace = _sessionTraces.get(sessionId);
  if (!trace) return;
  if (trace.stageSpanId) endSpan(trace.stageSpanId);
  const spanId = startSpan({
    name: `stage:${attrs.stage}`,
    traceId: trace.traceId,
    parentSpanId: trace.sessionSpanId,
    attributes: {
      "stage.name": attrs.stage,
      ...(attrs.agent ? { "stage.agent": attrs.agent } : {}),
      ...(attrs.gate ? { "stage.gate": attrs.gate } : {}),
    },
  });
  trace.stageSpanId = spanId;
}

export function emitStageSpanEnd(
  sessionId: string,
  attrs?: {
    status?: string;
    retries?: number;
  },
): void {
  const trace = _sessionTraces.get(sessionId);
  if (!trace?.stageSpanId) return;
  endSpan(trace.stageSpanId, {
    ...(attrs?.status ? { "stage.status": attrs.status } : {}),
    ...(attrs?.retries != null ? { "stage.retries": attrs.retries } : {}),
  });
  trace.stageSpanId = undefined;
}
