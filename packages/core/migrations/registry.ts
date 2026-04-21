/**
 * Ordered registry of every Ark migration.
 *
 * Add new migrations here in monotonic order. The runner refuses to apply
 * out-of-order versions and refuses to skip numbers.
 */

import type { Migration } from "./types.js";
import * as m001 from "./001_initial.js";

export const MIGRATIONS: ReadonlyArray<Migration> = [{ version: m001.VERSION, name: m001.NAME, up: m001.up }];
