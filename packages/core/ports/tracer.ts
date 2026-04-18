/**
 * Tracer port -- distributed tracing (OpenTelemetry-compatible).
 *
 * Replaces the module-level state in `packages/core/observability/otlp.ts`.
 * Adapters hide the choice of OTLP / stdout / no-op behind a tiny facade.
 *
 * Local + control-plane binding: `OtlpTracer` (exports to collector).
 * Test binding: `NoopTracer`.
 */

export type SpanAttrs = Record<string, string | number | boolean | undefined>;

export interface Span {
  /** End the span. Optionally record a final attribute bag. */
  end(attrs?: SpanAttrs): void;

  /** Attach additional attributes to an in-flight span. */
  setAttrs(attrs: SpanAttrs): void;

  /** Record an exception / error against the span. */
  recordError(err: unknown): void;
}

export interface Tracer {
  /** Start a span with an initial attribute bag. Caller must `end()` it. */
  startSpan(name: string, attrs?: SpanAttrs): Span;

  /**
   * Convenience wrapper that starts a span, runs `fn`, and ends the span
   * regardless of throw. Exceptions are recorded then rethrown.
   */
  withSpan<T>(name: string, attrs: SpanAttrs, fn: (span: Span) => Promise<T>): Promise<T>;

  /** Flush pending spans to the collector. */
  flush(): Promise<void>;
}
