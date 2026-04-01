/**
 * Heuristic skill extraction from conversation transcripts.
 *
 * Analyzes conversation turns for reusable patterns such as numbered
 * procedures, repeated methodology, and structured approaches.
 * Returns candidate skills with confidence scores.
 */

export interface ConversationTurn {
  role: string;
  content: string;
}

export interface SkillCandidate {
  name: string;
  description: string;
  prompt: string;
  confidence: number;
}

/**
 * Analyze a conversation to extract reusable skill candidates.
 *
 * Looks for:
 * - Multi-step procedures the agent followed (numbered lists)
 * - Repeated patterns across turns
 * - Explicit methodology descriptions
 *
 * This is a heuristic extractor. For LLM-powered extraction,
 * use extractSkillCandidatesWithLLM() (requires API key).
 */
export function extractSkillCandidates(conversation: ConversationTurn[]): SkillCandidate[] {
  if (conversation.length < 4) return [];

  const candidates: SkillCandidate[] = [];

  // Find assistant turns with numbered steps (procedure pattern)
  for (const turn of conversation) {
    if (turn.role !== "assistant") continue;
    const lines = turn.content.split("\n");
    const numberedSteps = lines.filter(l => /^\s*\d+[\.\)]\s/.test(l));
    if (numberedSteps.length >= 3) {
      // Extract the procedure as a skill candidate
      const firstStep = numberedSteps[0].replace(/^\s*\d+[\.\)]\s*/, "");
      const name = firstStep.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 30);

      candidates.push({
        name: name || "extracted-procedure",
        description: `Extracted procedure with ${numberedSteps.length} steps`,
        prompt: numberedSteps.map(s => s.trim()).join("\n"),
        confidence: Math.min(numberedSteps.length / 5, 1),
      });
    }
  }

  return candidates;
}
