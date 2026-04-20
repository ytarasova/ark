/**
 * StderrObservability -- local-mode sink that writes structured lines to
 * stderr via the existing structured-log infrastructure. No metrics; spans
 * are reduced to start + end log entries.
 *
 * Control-plane mode uses OtlpObservability (Wave 3).
 */

import { logDebug } from "../../observability/structured-log.js";
import type { Observability, ObservabilitySpan } from "../interfaces/observability.js";

export class StderrObservability implements Observability {
  startSpan(name: string, attrs: Record<string, unknown> = {}): ObservabilitySpan {
    const started = Date.now();
    logDebug("code-intel", `span.start ${name}`, attrs);
    const spanAttrs: Record<string, unknown> = { ...attrs };
    let ended = false;
    return {
      setAttribute(key, value) {
        spanAttrs[key] = value;
      },
      recordError(err) {
        spanAttrs.error = err.message;
      },
      end(endAttrs = {}) {
        if (ended) return;
        ended = true;
        logDebug("code-intel", `span.end ${name} ${Date.now() - started}ms`, { ...spanAttrs, ...endAttrs });
      },
    };
  }

  counter(name: string, value = 1, labels: Record<string, string> = {}): void {
    logDebug("code-intel", `counter ${name}=${value}`, labels);
  }

  histogram(name: string, value: number, labels: Record<string, string> = {}): void {
    logDebug("code-intel", `histogram ${name}=${value}`, labels);
  }

  event(name: string, attrs: Record<string, unknown> = {}): void {
    logDebug("code-intel", `event ${name}`, attrs);
  }
}
