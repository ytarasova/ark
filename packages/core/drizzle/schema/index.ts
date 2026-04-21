/**
 * Dialect-split drizzle schema entry points.
 *
 * Import the dialect that matches your runtime:
 *   import * as schema from "./schema/sqlite.js";   // or "./schema/postgres.js"
 *
 * Row types flow through `InferSelectModel<typeof schema.<table>>`. See
 * `packages/core/drizzle/types.ts` for the canonical re-exports used by
 * repositories and the `@ark/types` package.
 */

export * as sqliteSchema from "./sqlite.js";
export * as pgSchema from "./postgres.js";
