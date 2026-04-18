/**
 * MemoryLogger adapter -- stub.
 *
 * Slice 3: in-memory buffer of log lines for assertion in tests.
 */

import type { Logger, LogFields } from "../../ports/logger.js";

const NOT_MIGRATED = new Error("MemoryLogger: not migrated yet -- Slice 3");

export class MemoryLogger implements Logger {
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
