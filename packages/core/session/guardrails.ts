/**
 * Guardrails -- pattern-based tool authorization.
 *
 * Evaluates tool calls against a set of rules to determine
 * whether they should be blocked, warned about, or allowed.
 */

export interface GuardrailRule {
  tool: string;
  pattern: string;
  action: "block" | "warn" | "allow";
}

/**
 * Evaluate a tool call against guardrail rules.
 *
 * Serializes the tool input to JSON and matches each rule's regex
 * pattern against the result. Returns the action of the first
 * matching rule, or "allow" if no rule matches.
 *
 * Invalid regex patterns in rules are silently skipped.
 */
export function evaluateGuardrail(
  rules: GuardrailRule[],
  toolName: string,
  toolInput: Record<string, any>,
): "block" | "warn" | "allow" {
  const inputStr = JSON.stringify(toolInput);

  for (const rule of rules) {
    if (rule.tool !== toolName) continue;
    try {
      if (new RegExp(rule.pattern).test(inputStr)) {
        return rule.action;
      }
    } catch {
      // Invalid regex - skip rule
    }
  }

  return "allow";
}

/** Default guardrail rules for dangerous commands. */
export const DEFAULT_RULES: GuardrailRule[] = [
  { tool: "Bash", pattern: "rm\\s+-rf\\s+/(?!tmp)", action: "block" },
  { tool: "Bash", pattern: "DROP\\s+TABLE|DROP\\s+DATABASE", action: "block" },
  { tool: "Bash", pattern: ":\\(\\)\\{\\s*:|:&\\s*\\};:", action: "block" },
  { tool: "Bash", pattern: "mkfs\\.|fdisk|dd\\s+if=", action: "block" },
  { tool: "Bash", pattern: "git\\s+push.*--force|git\\s+push.*-f\\b", action: "block" },
  { tool: "Read", pattern: '\\.env"', action: "warn" },
  { tool: "Read", pattern: "credentials", action: "warn" },
  { tool: "Write", pattern: '\\.env"', action: "warn" },
  { tool: "Write", pattern: "credentials", action: "warn" },
];

/** Evaluate a tool call against default + custom rules. Returns action and matching rule. */
export function evaluateToolCall(
  toolName: string,
  toolInput: Record<string, any>,
  customRules?: GuardrailRule[],
): { action: "block" | "warn" | "allow"; rule?: GuardrailRule } {
  const rules = [...DEFAULT_RULES, ...(customRules ?? [])];
  const inputStr = JSON.stringify(toolInput);

  for (const rule of rules) {
    if (rule.tool !== toolName) continue;
    try {
      if (new RegExp(rule.pattern).test(inputStr)) {
        return { action: rule.action, rule };
      }
    } catch {
      /* skip invalid regex */
    }
  }

  return { action: "allow" };
}
