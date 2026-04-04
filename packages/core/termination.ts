/**
 * Composable termination conditions for flow stages.
 * Conditions combine with AND/OR operators.
 */

import type { Session } from "./store.js";

export interface TerminationContext {
  session: Session;
  turnCount: number;
  tokenCount: number;
  elapsedMs: number;
  lastOutput: string;
}

export type TerminationCondition = {
  type: "maxTurns"; value: number;
} | {
  type: "maxTokens"; value: number;
} | {
  type: "timeout"; valueMs: number;
} | {
  type: "textMention"; text: string;
} | {
  type: "status"; status: string;
} | {
  type: "and"; conditions: TerminationCondition[];
} | {
  type: "or"; conditions: TerminationCondition[];
};

/** Evaluate a termination condition against context. */
export function evaluateTermination(condition: TerminationCondition, ctx: TerminationContext): boolean {
  switch (condition.type) {
    case "maxTurns": return ctx.turnCount >= condition.value;
    case "maxTokens": return ctx.tokenCount >= condition.value;
    case "timeout": return ctx.elapsedMs >= condition.valueMs;
    case "textMention": return ctx.lastOutput.includes(condition.text);
    case "status": return ctx.session.status === condition.status;
    case "and": return condition.conditions.every(c => evaluateTermination(c, ctx));
    case "or": return condition.conditions.some(c => evaluateTermination(c, ctx));
  }
}

/** Parse a termination condition from YAML-friendly object. */
export function parseTermination(obj: any): TerminationCondition | null {
  if (!obj) return null;
  if (obj.maxTurns) return { type: "maxTurns", value: obj.maxTurns };
  if (obj.maxTokens) return { type: "maxTokens", value: obj.maxTokens };
  if (obj.timeout) return { type: "timeout", valueMs: obj.timeout * 1000 };
  if (obj.textMention) return { type: "textMention", text: obj.textMention };
  if (obj.status) return { type: "status", status: obj.status };
  if (obj.and) return { type: "and", conditions: obj.and.map(parseTermination).filter(Boolean) };
  if (obj.or) return { type: "or", conditions: obj.or.map(parseTermination).filter(Boolean) };
  return null;
}

/** Shorthand constructors. */
export const maxTurns = (n: number): TerminationCondition => ({ type: "maxTurns", value: n });
export const maxTokens = (n: number): TerminationCondition => ({ type: "maxTokens", value: n });
export const timeout = (seconds: number): TerminationCondition => ({ type: "timeout", valueMs: seconds * 1000 });
export const textMention = (text: string): TerminationCondition => ({ type: "textMention", text });
export const and = (...conditions: TerminationCondition[]): TerminationCondition => ({ type: "and", conditions });
export const or = (...conditions: TerminationCondition[]): TerminationCondition => ({ type: "or", conditions });
