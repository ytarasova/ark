/**
 * Claude model short-name mapping. Split out from claude.ts so model
 * resolution can be imported without dragging in fs / tmux dependencies.
 */

export const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

export function resolveModel(short: string): string {
  return MODEL_MAP[short] ?? short;
}
