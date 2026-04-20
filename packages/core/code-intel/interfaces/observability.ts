/**
 * Observability -- logs, metrics, spans for code-intel operations.
 *
 * Local mode: structured log lines to stderr (via the existing structured
 *   logger) + no-op metrics.
 * Control-plane mode: OTLP spans (tenant-scoped) + Prometheus counters +
 *   per-tenant Grafana dashboards.
 *
 * Every extractor + query + pipeline call emits through this interface so
 * control-plane can capture telemetry without any call-site change.
 *
 * Example:
 *   const span = deployment.observability.startSpan("extractor.run", {
 *     tenant_id, extractor: "files", run_id,
 *   });
 *   try { ... } finally { span.end({ rows_emitted: N }); }
 */

export interface ObservabilitySpan {
  end(attrs?: Record<string, unknown>): void;
  setAttribute(key: string, value: unknown): void;
  recordError(err: Error): void;
}

export interface Observability {
  startSpan(name: string, attrs?: Record<string, unknown>): ObservabilitySpan;
  counter(name: string, value?: number, labels?: Record<string, string>): void;
  histogram(name: string, value: number, labels?: Record<string, string>): void;
  event(name: string, attrs?: Record<string, unknown>): void;
}
