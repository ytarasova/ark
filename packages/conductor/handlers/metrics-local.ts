/**
 * Local-mode-only metrics handlers: privileged host commands.
 *
 * `compute/kill-process`, `compute/docker-logs`, `compute/docker-action` all
 * execute privileged commands against the server host. Allowing these in
 * hosted multi-tenant mode would let one tenant signal another tenant's pids
 * or introspect arbitrary containers on the control plane host. Registered
 * conditionally when `app.mode.hostCommandCapability` is non-null.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { RpcError, ErrorCodes } from "../../protocol/types.js";

// Docker container names follow a restricted charset. Enforce it here to keep
// command injection impossible even if the capability were ever swapped for
// a shell variant.
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

export function registerMetricsLocalHandlers(router: Router, app: AppContext): void {
  const host = app.mode.hostCommandCapability;
  if (!host) {
    throw new Error("hostCommandCapability is required to register local-only metrics handlers");
  }

  router.handle("compute/kill-process", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const pidRaw = params.pid;
    // Coerce to a positive integer and reject anything else. Without this
    // `String(pid)` would let a caller pass "-1" (kill every process in the
    // caller's session) or other shell-ish tokens that the host capability
    // forwards verbatim as argv to `kill`.
    const pid = Math.trunc(Number(pidRaw));
    if (!Number.isFinite(pid) || pid <= 1) {
      throw new RpcError("pid must be a positive integer greater than 1", ErrorCodes.INVALID_PARAMS);
    }
    try {
      await host.killProcess(pid);
      return { ok: true };
    } catch (err: any) {
      throw new RpcError(`Failed to kill process ${pid}: ${err.message}`, ErrorCodes.INTERNAL_ERROR);
    }
  });

  router.handle("compute/docker-logs", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const container = params.container;
    if (typeof container !== "string" || !DOCKER_NAME_RE.test(container)) {
      throw new RpcError("container must be a valid docker name", ErrorCodes.INVALID_PARAMS);
    }
    const tailNum = Math.trunc(Number(params.tail ?? 100));
    const tail = Number.isFinite(tailNum) && tailNum > 0 && tailNum <= 10000 ? tailNum : 100;
    try {
      const logs = await host.dockerLogs(container, tail);
      return { logs };
    } catch (err: any) {
      throw new RpcError(`Failed to get logs for ${container}: ${err.message}`, ErrorCodes.INTERNAL_ERROR);
    }
  });

  router.handle("compute/docker-action", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const container = params.container;
    const action = params.action;
    if (typeof container !== "string" || !DOCKER_NAME_RE.test(container)) {
      throw new RpcError("container must be a valid docker name", ErrorCodes.INVALID_PARAMS);
    }
    if (!action || !["stop", "restart"].includes(action)) {
      throw new RpcError("action must be stop or restart", ErrorCodes.INVALID_PARAMS);
    }
    try {
      await host.dockerAction(container, action as "stop" | "restart");
      return { ok: true };
    } catch (err: any) {
      throw new RpcError(`Failed to ${action} container ${container}: ${err.message}`, ErrorCodes.INTERNAL_ERROR);
    }
  });
}
