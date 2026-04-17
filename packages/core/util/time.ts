/** Shared ISO-8601 timestamp helper. */
export function now(): string {
  return new Date().toISOString();
}
