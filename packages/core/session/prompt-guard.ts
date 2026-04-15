/**
 * Prompt injection detection — scans content for injection attempts.
 * Lightweight heuristic detection, not a security boundary.
 */

export interface InjectionResult {
  detected: boolean;
  patterns: string[];
  severity: "none" | "low" | "medium" | "high";
}

const INJECTION_PATTERNS: Array<{ pattern: RegExp; name: string; severity: "low" | "medium" | "high" }> = [
  {
    pattern: /ignore (?:all )?(?:previous|above|prior) (?:instructions|prompts)/i,
    name: "ignore-instructions",
    severity: "high",
  },
  {
    pattern: /disregard (?:all )?(?:previous|your) (?:instructions|rules|guidelines)/i,
    name: "disregard-rules",
    severity: "high",
  },
  { pattern: /you are now (?:a|an) (?:different|new)/i, name: "role-override", severity: "high" },
  { pattern: /pretend (?:you are|to be|that)/i, name: "pretend-role", severity: "medium" },
  {
    pattern: /forget (?:all|everything|your) (?:previous|instructions|rules)/i,
    name: "forget-instructions",
    severity: "high",
  },
  { pattern: /system:\s*you are/i, name: "fake-system-prompt", severity: "high" },
  { pattern: /\[SYSTEM\]/i, name: "fake-system-tag", severity: "medium" },
  {
    pattern: /act as (?:if|though) you (?:have|had) no (?:restrictions|rules|limits)/i,
    name: "remove-restrictions",
    severity: "high",
  },
  {
    pattern: /reveal (?:your|the) (?:system|initial|original) (?:prompt|instructions)/i,
    name: "prompt-extraction",
    severity: "medium",
  },
  {
    pattern: /what (?:are|were) your (?:original|system|initial) instructions/i,
    name: "instruction-extraction",
    severity: "low",
  },
];

/** Scan text for potential prompt injection patterns. */
export function detectInjection(text: string): InjectionResult {
  const found: string[] = [];
  let maxSeverity: "none" | "low" | "medium" | "high" = "none";
  const severityOrder = { none: 0, low: 1, medium: 2, high: 3 };

  for (const { pattern, name, severity } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      found.push(name);
      if (severityOrder[severity] > severityOrder[maxSeverity]) {
        maxSeverity = severity;
      }
    }
  }

  return { detected: found.length > 0, patterns: found, severity: maxSeverity };
}

/** Quick check — returns true if injection detected. */
export function hasInjection(text: string): boolean {
  return detectInjection(text).detected;
}
