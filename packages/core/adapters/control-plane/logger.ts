/**
 * CloudLogger adapter -- stub.
 *
 * Writes structured JSON to stdout for container log stacks. Slice 3.
 */

import type { Logger, LogFields } from "../../ports/logger.js";

const NOT_MIGRATED = new Error("CloudLogger: not migrated yet -- Slice 3");

export class CloudLogger implements Logger {
  debug(_component: string, _msg: string, _fields?: LogFields): void {
    throw NOT_MIGRATED;
  }
  info(_component: string, _msg: string, _fields?: LogFields): void {
    throw NOT_MIGRATED;
  }
  warn(_component: string, _msg: string, _fields?: LogFields): void {
    throw NOT_MIGRATED;
  }
  error(_component: string, _msg: string, _fields?: LogFields & { err?: unknown }): void {
    throw NOT_MIGRATED;
  }
  child(_fields: LogFields): Logger {
    throw NOT_MIGRATED;
  }
}
