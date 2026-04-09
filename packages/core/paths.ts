/**
 * @deprecated These global path accessors use getApp() and will be removed.
 * Use app.config.arkDir, app.config.dbPath, app.config.tracksDir,
 * app.config.worktreesDir instead, where `app` is passed as a parameter.
 */
import { getApp } from "./app.js";

/** @deprecated Use app.config.arkDir instead */
export function ARK_DIR(): string { return getApp().config.arkDir; }
/** @deprecated Use app.config.dbPath instead */
export function DB_PATH(): string { return getApp().config.dbPath; }
/** @deprecated Use app.config.tracksDir instead */
export function TRACKS_DIR(): string { return getApp().config.tracksDir; }
/** @deprecated Use app.config.worktreesDir instead */
export function WORKTREES_DIR(): string { return getApp().config.worktreesDir; }
