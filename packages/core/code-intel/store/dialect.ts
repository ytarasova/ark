/**
 * Shared base class for every code-intel store repository.
 *
 * Each repository module (tenants, repos, indexing-runs, ...) takes a
 * `DatabaseAdapter` + dialect and exposes a narrow slice of the schema.
 * The facade `CodeIntelStore` composes them and delegates.
 *
 * Keeping `ph` / `phs` here means every sub-store renders placeholders the
 * same way and we don't duplicate the SQLite (`?`) vs Postgres (`$N`) rule.
 */

import type { DatabaseAdapter } from "../../database/index.js";

export type Dialect = "sqlite" | "postgres";

export class StoreDialect {
  constructor(
    protected readonly db: DatabaseAdapter,
    protected readonly dialect: Dialect,
  ) {}

  /**
   * Render a single placeholder at logical position `index` (1-based).
   *
   * SQLite always returns `?` (positional anonymous binding).
   * Postgres returns `$N` so the same call site works for both dialects.
   *
   * For comma-separated `(?, ?, ?, ?)` use `phs(start, count)` instead.
   */
  protected ph(index: number): string {
    return this.dialect === "sqlite" ? "?" : `$${index}`;
  }

  /** Produce `count` placeholders separated by ", " starting at `start`. */
  protected phs(start: number, count: number): string {
    return Array.from({ length: count }, (_, i) => this.ph(start + i)).join(", ");
  }
}
