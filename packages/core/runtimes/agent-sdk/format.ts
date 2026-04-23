/**
 * Pretty-formatter for agent-sdk transcript.jsonl lines.
 *
 * Each line in transcript.jsonl is a verbatim SDKMessage JSON object.
 * formatTranscriptLine() maps each to a single human-readable string.
 * formatTranscriptStream() is an async generator that yields formatted lines
 * from a transcript file path -- useful for tail-like streaming in the CLI.
 */

import { createReadStream, existsSync } from "fs";
import { createInterface } from "readline";

type Block = { type: string; [k: string]: unknown };

/**
 * Format a single raw transcript.jsonl line into a human-readable string.
 * Returns the raw line unchanged if it is not valid JSON.
 */
export function formatTranscriptLine(raw: string): string {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return raw;
  }

  const t = (m.type as string) ?? "?";
  const sub = m.subtype ? `/${m.subtype as string}` : "";

  // system/init -- cwd, model, tools list
  if (t === "system" && m.subtype === "init") {
    const tools = (m.tools as string[] | undefined) ?? [];
    const toolList = tools.slice(0, 6).join(",") + (tools.length > 6 ? ",..." : "");
    return `system/init       cwd=${m.cwd ?? "?"} model=${m.model ?? "?"} tools=[${toolList}]`;
  }

  // system/api_retry
  if (t === "system" && m.subtype === "api_retry") {
    return `system/api_retry  attempt=${m.attempt}/${m.max_retries} status=${m.error_status} error=${m.error}`;
  }

  // generic system messages
  if (t === "system") {
    const msg = typeof m.message === "string" ? ` ${m.message}` : "";
    return `system${sub}${msg}`.trim();
  }

  // assistant / user -- render content blocks
  if (t === "assistant" || t === "user") {
    const content = (m.message as Record<string, unknown> | undefined)?.content;
    const blocks = (Array.isArray(content) ? content : []) as Block[];
    const parts = blocks.map((b) => {
      if (b.type === "text") {
        return JSON.stringify(String(b.text ?? "").slice(0, 80));
      }
      if (b.type === "tool_use") {
        const inputStr = JSON.stringify(b.input).slice(0, 60);
        return `tool_use ${b.name}(${inputStr})`;
      }
      if (b.type === "tool_result") {
        const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        const errFlag = b.is_error ? " ERR" : "";
        return `tool_result(${content.length}b${errFlag})`;
      }
      return String(b.type);
    });
    return `${t.padEnd(10)}  ${parts.join("  |  ")}`;
  }

  // result messages
  if (t === "result") {
    const ok = m.is_error ? "FAIL" : "OK";
    const cost = ((m.total_cost_usd as number | undefined) ?? 0).toFixed(4);
    const turns = m.num_turns ?? "?";
    const durationSec = Math.round(((m.duration_ms as number | undefined) ?? 0) / 1000);
    return `result${sub}  ${ok}  cost=$${cost} turns=${turns} duration=${durationSec}s`;
  }

  // error sentinel (written by launch.ts on crash or stream end without result)
  if (t === "error") {
    const msg = typeof m.message === "string" ? ` ${m.message}` : "";
    const src = m.source ? ` [${m.source}]` : "";
    return `error${src}${msg}`.trim();
  }

  // fallback: stringify truncated
  return `${t}${sub}  ${JSON.stringify(m).slice(0, 100)}`;
}

/**
 * Async generator that opens a transcript.jsonl file, reads all existing lines,
 * and yields each formatted. Non-blocking; does not tail (use tail -F for live
 * streaming in the CLI attach path).
 */
export async function* formatTranscriptStream(path: string): AsyncIterable<string> {
  if (!existsSync(path)) return;

  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) yield formatTranscriptLine(trimmed);
  }
}
