/**
 * Error shapes for the arkd protocol.
 *
 * `ArkdError` is the wire envelope arkd returns on non-2xx (already
 * defined in `./types.ts` and re-exported here). The two classes below
 * are thrown by `ArkdClient`; transport errors carry request context so
 * UI surfaces show what actually failed.
 */

export type { ArkdError } from "./types.js";

/** Thrown by ArkdClient when the server returns a non-2xx response. */
export class ArkdClientError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ArkdClientError";
  }
}

/**
 * Thrown when fetch() itself fails (DNS / connect / socket-close /
 * timeout) -- distinct from `ArkdClientError`, which is a clean non-2xx
 * arkd-side reject. Carries the request URL + method + attempt count so
 * a session that fails dispatch surfaces an actionable message in the
 * UI instead of a bare `TypeError: socket closed`. The original error
 * is preserved on `.cause` for stack-trace reconstruction.
 */
export class ArkdClientTransportError extends Error {
  readonly url: string;
  readonly method: string;
  readonly path: string;
  readonly attempts: number;
  constructor(message: string, opts: { url: string; method: string; path: string; attempts: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "ArkdClientTransportError";
    this.url = opts.url;
    this.method = opts.method;
    this.path = opts.path;
    this.attempts = opts.attempts;
  }
}
