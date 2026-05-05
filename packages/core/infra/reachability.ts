/**
 * Structured reachability diagnostics for arkd / conductor health probes.
 *
 * The `daemon/status` RPC previously returned a bare `{online: boolean}`
 * per service. When arkd was offline the UI had nothing to render except
 * "Could not reach arkd" -- no port, no error code, no clue whether the
 * daemon was wedged, behind a timeout, or simply not running.
 *
 * `probeReachability` keeps the legacy boolean but captures the failure
 * reason, attempted URL, HTTP status (if any), and measured latency so
 * callers can surface an actionable diagnostic. The categorisation
 * intentionally distinguishes the three cases operators debug:
 *
 *   - `connection-refused`  nothing listening on the port. Start the daemon.
 *   - `timeout`             process reachable but /health didn't answer in
 *                           time. The daemon is wedged or the transport
 *                           (SSM port-forward, docker bridge, ...) is
 *                           overloaded.
 *   - `http-error`          got a response with a non-2xx status. The
 *                           daemon is up but reporting a problem.
 *
 * Any other failure collapses to `unknown` with the raw message preserved.
 * The shape is deliberately serialisable -- it rides the RPC response
 * straight to the web UI.
 */

export type ReachabilityReason = "connection-refused" | "timeout" | "http-error" | "unknown";

export interface ReachabilityResult {
  online: boolean;
  url: string;
  latencyMs: number;
  reason?: ReachabilityReason;
  message?: string;
  httpStatus?: number;
}

/**
 * GET `${baseUrl}/health` with a short timeout and return a structured
 * diagnostic. Never throws -- network failures are captured as
 * `online: false` with the categorised reason.
 */
export async function probeReachability(baseUrl: string, timeoutMs = 2000): Promise<ReachabilityResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    if (resp.ok) {
      return { online: true, url: baseUrl, latencyMs, httpStatus: resp.status };
    }
    return {
      online: false,
      url: baseUrl,
      latencyMs,
      reason: "http-error",
      message: `/health returned HTTP ${resp.status}`,
      httpStatus: resp.status,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    return {
      online: false,
      url: baseUrl,
      latencyMs,
      ...classifyFetchError(err, timeoutMs),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map a fetch() rejection to a stable `reason` + human message. Bun and
 * Node surface the underlying transport failure differently: Bun sets
 * `err.code = "ConnectionRefused"` and emits a generic "Unable to
 * connect" message, Node surfaces `ECONNREFUSED` in the message itself.
 * Timeouts come through as `AbortError` (ours) or `TimeoutError` on
 * some runtimes. We check the runtime-specific code field first, then
 * fall back to message-substring matching so the classifier works on
 * both without a runtime dependency.
 */
function classifyFetchError(err: unknown, timeoutMs: number): { reason: ReachabilityReason; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const code = (err as { code?: string } | undefined)?.code ?? "";
  const lower = raw.toLowerCase();

  if (name === "AbortError" || name === "TimeoutError" || lower.includes("timed out") || code === "TimeoutError") {
    return { reason: "timeout", message: `health probe timed out after ${timeoutMs}ms` };
  }
  if (
    code === "ConnectionRefused" ||
    code === "ECONNREFUSED" ||
    lower.includes("econnrefused") ||
    lower.includes("connection refused")
  ) {
    return { reason: "connection-refused", message: raw || "connection refused" };
  }
  return { reason: "unknown", message: raw || "unknown fetch failure" };
}
