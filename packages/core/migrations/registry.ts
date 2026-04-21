/**
 * Ordered registry of every Ark migration.
 *
 * Add new migrations here in monotonic order. The runner refuses to apply
 * out-of-order versions and refuses to skip numbers.
 */

import type { Migration } from "./types.js";
import * as m001 from "./001_initial.js";
import * as m002 from "./002_compute_unify.js";
import * as m003 from "./003_tenants_teams.js";

export const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: m001.VERSION, name: m001.NAME, up: m001.up },
  { version: m002.VERSION, name: m002.NAME, up: m002.up },
  { version: m003.VERSION, name: m003.NAME, up: m003.up },
];
