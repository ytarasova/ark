/**
 * FileLogger adapter -- stub.
 *
 * In Slice 3 this will wrap the existing structured-log module
 * (`observability/structured-log.ts`) and write JSONL to `$ARK_DIR/logs`.
 */

import type { Logger, LogFields } from "../../ports/logger.js";

const NOT_MIGRATED = new Error("FileLogger: not migrated yet -- Slice 3");

export class FileLogger implements Logger {
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
