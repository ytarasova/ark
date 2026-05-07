/**
 * Escape a string for safe interpolation inside single-quoted shell arguments.
 */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
