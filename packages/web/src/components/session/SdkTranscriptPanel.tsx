import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../hooks/useApi.js";
import { AgentMessage } from "../ui/AgentMessage.js";
import { SystemEvent } from "../ui/SystemEvent.js";
import { MarkdownContent } from "../ui/MarkdownContent.js";
import { ToolBlock } from "./tool-block/index.js";
import { cn } from "../../lib/utils.js";

interface SdkTranscriptPanelProps {
  sessionId: string;
  status?: string | null;
  isRunning?: boolean;
}

const TERMINAL_STATES = new Set(["completed", "failed", "stopped", "archived"]);
const POLL_MS = 3000;

/**
 * Renders `tracks/<id>/transcript.jsonl` for agent-sdk sessions.
 *
 * Pairs `tool_result` messages (on user turns) with the preceding `tool_use`
 * by `tool_use_id` so the output shows up in the same ToolBlock card. Pulls
 * system/init + result blocks out into dedicated cards above / below the
 * conversation so the cost + model preview is visible even when the events
 * stream is sparse.
 */
export function SdkTranscriptPanel({ sessionId, status, isRunning }: SdkTranscriptPanelProps) {
  const api = useApi();
  const refetchInterval = isRunning || (status && !TERMINAL_STATES.has(status)) ? POLL_MS : false;

  const query = useQuery({
    queryKey: ["session-transcript", sessionId],
    queryFn: () => api.getTranscript(sessionId),
    refetchInterval,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const render = useMemo(() => buildRenderList(query.data?.messages ?? []), [query.data]);

  if (query.isLoading) return null;
  if (!query.data?.exists && render.items.length === 0) return null;

  return (
    <section data-testid="sdk-transcript" className="flex flex-col gap-[10px]">
      {render.init && <InitCard init={render.init} />}
      {render.items.map((item, i) => {
        if (item.kind === "assistant-text") {
          return (
            <AgentMessage key={`txt-${i}`} agentName="assistant" model={render.init?.model}>
              <MarkdownContent content={item.text} />
            </AgentMessage>
          );
        }
        if (item.kind === "tool-use") {
          return (
            <ToolBlock
              key={`tu-${i}-${item.toolUseId}`}
              name={item.name}
              input={item.input}
              output={item.output}
              status={item.status}
            />
          );
        }
        if (item.kind === "system") {
          return (
            <SystemEvent key={`sys-${i}`}>
              {item.subtype ? `${item.subtype}: ` : ""}
              {item.text ?? ""}
            </SystemEvent>
          );
        }
        return null;
      })}
      {render.result && <ResultCard result={render.result} />}
    </section>
  );
}

/* ── internal render model ──────────────────────────────────────────────── */

interface InitInfo {
  cwd?: string;
  model?: string;
  tools?: string[];
}

interface ResultInfo {
  isError: boolean;
  totalCostUsd?: number;
  numTurns?: number;
  result?: string;
  error?: string;
}

type RenderItem =
  | { kind: "assistant-text"; text: string }
  | {
      kind: "tool-use";
      toolUseId: string;
      name: string;
      input: unknown;
      output?: unknown;
      status: "ok" | "err" | "running";
    }
  | { kind: "system"; subtype?: string; text?: string };

interface RenderList {
  init?: InitInfo;
  items: RenderItem[];
  result?: ResultInfo;
}

function buildRenderList(messages: unknown[]): RenderList {
  const items: RenderItem[] = [];
  // tool_use index keyed by id so tool_result messages can patch the output.
  const toolById = new Map<string, Extract<RenderItem, { kind: "tool-use" }>>();
  let init: InitInfo | undefined;
  let result: ResultInfo | undefined;

  for (const raw of messages) {
    const m = raw as any;
    if (!m || typeof m !== "object") continue;
    const type = m.type;

    if (type === "system" && m.subtype === "init") {
      init = {
        cwd: m.cwd,
        model: m.model,
        tools: Array.isArray(m.tools) ? m.tools.slice(0, 12) : undefined,
      };
      continue;
    }

    if (type === "assistant") {
      // The SDK emits `message.content` as a content-block array with text /
      // tool_use blocks interleaved. Older payloads may put a raw string at
      // `.content` or `.message.content`. Handle both.
      const content = m.message?.content ?? m.content;
      if (typeof content === "string" && content.trim()) {
        items.push({ kind: "assistant-text", text: content });
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            items.push({ kind: "assistant-text", text: block.text });
          } else if (block.type === "tool_use") {
            const entry: Extract<RenderItem, { kind: "tool-use" }> = {
              kind: "tool-use",
              toolUseId: block.id ?? `tu-${items.length}`,
              name: block.name ?? "tool",
              input: block.input,
              status: "running",
            };
            items.push(entry);
            toolById.set(entry.toolUseId, entry);
          }
        }
      }
      continue;
    }

    if (type === "user") {
      const content = m.message?.content ?? m.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "tool_result") {
            const match = toolById.get(block.tool_use_id);
            if (match) {
              match.output = extractToolResultOutput(block);
              match.status = block.is_error ? "err" : "ok";
            }
          }
        }
      }
      continue;
    }

    if (type === "result") {
      result = {
        isError: !!m.is_error,
        totalCostUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined,
        numTurns: typeof m.num_turns === "number" ? m.num_turns : undefined,
        result: typeof m.result === "string" ? m.result : undefined,
        error: typeof m.error === "string" ? m.error : m.result,
      };
      continue;
    }

    // Unknown shapes go through as a generic system row so we never drop data.
    items.push({ kind: "system", subtype: type, text: typeof m.subtype === "string" ? m.subtype : undefined });
  }

  return { init, items, result };
}

function extractToolResultOutput(block: any): unknown {
  // Anthropic content blocks nest the text under `content` as an array of
  // {type:"text", text:"..."} entries. Some SDK versions pass a plain string.
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const joined = c
      .map((x) => (typeof x === "string" ? x : x?.type === "text" ? x.text : ""))
      .filter(Boolean)
      .join("\n");
    return joined || undefined;
  }
  return c;
}

/* ── sub-components ─────────────────────────────────────────────────────── */

function InitCard({ init }: { init: InitInfo }) {
  return (
    <div
      data-testid="sdk-init-card"
      className={cn(
        "rounded-[9px] border border-[var(--border)] px-[12px] py-[8px]",
        "bg-[rgba(107,89,222,0.05)] text-[11.5px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]",
      )}
    >
      <div className="text-[var(--fg)]">Session started</div>
      <div className="mt-[4px] flex gap-[14px] flex-wrap">
        {init.cwd && (
          <span>
            cwd: <span className="text-[var(--fg)]">{init.cwd}</span>
          </span>
        )}
        {init.model && (
          <span>
            model: <span className="text-[var(--fg)]">{init.model}</span>
          </span>
        )}
        {init.tools && init.tools.length > 0 && (
          <span>
            tools: <span className="text-[var(--fg)]">{init.tools.slice(0, 6).join(", ")}</span>
            {init.tools.length > 6 && <span className="text-[var(--fg-faint)]"> +{init.tools.length - 6}</span>}
          </span>
        )}
      </div>
    </div>
  );
}

function ResultCard({ result }: { result: ResultInfo }) {
  if (result.isError) {
    return (
      <div
        data-testid="sdk-result-error"
        className={cn(
          "rounded-[9px] border border-[#f87171] px-[12px] py-[10px]",
          "bg-[rgba(248,113,113,0.08)] text-[12px] text-[#fca5a5]",
        )}
      >
        <div className="font-medium">Run failed</div>
        {result.error && (
          <div className="mt-[4px] whitespace-pre-wrap font-[family-name:var(--font-mono)] text-[11px]">
            {result.error}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      data-testid="sdk-result-card"
      className={cn(
        "rounded-[9px] border border-[var(--border)] px-[12px] py-[10px]",
        "bg-[rgba(52,211,153,0.06)] text-[12px] text-[var(--fg-muted)]",
      )}
    >
      <div className="flex items-center gap-[14px] font-[family-name:var(--font-mono-ui)] text-[10.5px]">
        {result.totalCostUsd != null && (
          <span>
            cost: <span className="text-[var(--fg)]">${result.totalCostUsd.toFixed(4)}</span>
          </span>
        )}
        {result.numTurns != null && (
          <span>
            turns: <span className="text-[var(--fg)]">{result.numTurns}</span>
          </span>
        )}
      </div>
      {result.result && (
        <div className="mt-[6px] whitespace-pre-wrap text-[12px] text-[var(--fg)]">{result.result}</div>
      )}
    </div>
  );
}
