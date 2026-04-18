/**
 * NoopTracer adapter -- stub.
 *
 * Slice 5: no-op spans so production tracing code runs in tests without an
 * exporter or collector.
 */

import type { Tracer, Span, SpanAttrs } from "../../ports/tracer.js";

const NOT_MIGRATED = new Error("NoopTracer: not migrated yet -- Slice 5");

export class NoopTracer implements Tracer {
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
