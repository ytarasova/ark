/**
 * Pure helper functions for the CLI, extracted for testability.
 */

/** Sanitize a session summary: alphanumeric, dash, underscore only, max 60 chars. */
export function sanitizeSummary(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || raw;
}

/** Split an editor command string safely for execFileSync. */
export function splitEditorCommand(editor: string): { command: string; args: string[] } {
  const parts = editor.split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}
