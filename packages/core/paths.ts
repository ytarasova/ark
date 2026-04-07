import { getApp } from "./app.js";

export function ARK_DIR(): string { return getApp().config.arkDir; }
export function DB_PATH(): string { return getApp().config.dbPath; }
export function TRACKS_DIR(): string { return getApp().config.tracksDir; }
export function WORKTREES_DIR(): string { return getApp().config.worktreesDir; }
