/**
 * OtlpTracer adapter -- stub.
 *
 * In Slice 5 this will wrap the existing OTLP exporter in
 * `observability/otlp.ts`.
 */

import type { Tracer, Span, SpanAttrs } from "../../ports/tracer.js";

const NOT_MIGRATED = new Error("OtlpTracer: not migrated yet -- Slice 5");

export class OtlpTracer implements Tracer {
  startSpan(_name: string, _attrs?: SpanAttrs): Span {
    throw NOT_MIGRATED;
  }
  async withSpan<T>(_name: string, _attrs: SpanAttrs, _fn: (span: Span) => Promise<T>): Promise<T> {
    throw NOT_MIGRATED;
  }
  async flush(): Promise<void> {
    throw NOT_MIGRATED;
  }
}
