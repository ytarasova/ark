/**
 * Structured review output parser.
 *
 * Extracts machine-parseable review results from agent output
 * that contains JSON in markdown code fences.
 */

export interface ReviewIssue {
  severity: "P0" | "P1" | "P2" | "P3";
  file: string;
  line?: number;
  title: string;
  description: string;
}

export interface ReviewResult {
  issues: ReviewIssue[];
  summary: string;
  approved: boolean;
}

/**
 * Parse structured review output from an agent response.
 *
 * Expects the agent to include a ```json code fence containing
 * a ReviewResult-shaped object with issues, summary, and approved fields.
 *
 * Returns null if no valid JSON block is found.
 */
export function parseReviewOutput(output: string): ReviewResult | null {
  // Extract JSON block from markdown code fence
  const match = output.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (!Array.isArray(parsed.issues)) return null;
    return {
      issues: parsed.issues.map((i: any) => ({
        severity: i.severity ?? "P2",
        file: i.file ?? "unknown",
        line: i.line ?? undefined,
        title: i.title ?? "",
        description: i.description ?? "",
      })),
      summary: parsed.summary ?? "",
      approved: parsed.approved ?? false,
    };
  } catch {
    return null;
  }
}
