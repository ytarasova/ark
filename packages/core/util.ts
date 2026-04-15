export function safeParseConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw ?? "{}"));
  } catch {
    return {};
  }
}
