/**
 * ControlPlaneOtlpTracer adapter -- stub.
 *
 * Same exporter shape as local; distinct class keeps the binding module
 * honest about not importing across adapter trees. Slice 5.
 */

import type { Tracer, Span, SpanAttrs } from "../../ports/tracer.js";

const NOT_MIGRATED = new Error("ControlPlaneOtlpTracer: not migrated yet -- Slice 5");

export class ControlPlaneOtlpTracer implements Tracer {
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
