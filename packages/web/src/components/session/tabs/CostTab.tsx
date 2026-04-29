import { KpiCard } from "../../ui/KpiCard.js";
import { fmtCost } from "../../../util.js";
import { friendlyAgentName } from "../../../lib/inline-display.js";

interface CostTabProps {
  session: any;
  // costs/session RPC returns input_tokens / output_tokens (matching the
  // ledger schema). Older callers pass tokens_in / tokens_out for back-
  // compat; we read either shape.
  cost:
    | {
        cost: number;
        input_tokens?: number;
        output_tokens?: number;
        tokens_in?: number;
        tokens_out?: number;
      }
    | null
    | undefined;
}

/**
 * Cost tab -- breakdown of spend for this session. KPI row up top, then a
 * simple table of token usage by direction. The daily-history bar chart
 * lives on the dashboard-level CostsView; per-session it is not meaningful.
 */
export function CostTab({ session, cost }: CostTabProps) {
  const tin = cost?.input_tokens ?? cost?.tokens_in ?? 0;
  const tout = cost?.output_tokens ?? cost?.tokens_out ?? 0;
  const total = tin + tout;
  // For inline-flow dispatches `session.agent === "inline"` is a placeholder,
  // not a real model name -- fall back to the agent's runtime via
  // friendlyAgentName so the Model row reads e.g. "agent-sdk" instead of
  // the literal "inline".
  const model = session?.config?.model || friendlyAgentName(session) || "--";
  return (
    <div className="max-w-[900px] mx-auto flex flex-col gap-[14px]">
      <div className="grid grid-cols-4 gap-[10px]">
        <KpiCard label="Cost" value={fmtCost(cost?.cost || 0)} color="amber" />
        <KpiCard label="Tokens In" value={compactNumber(tin)} color="blue" />
        <KpiCard label="Tokens Out" value={compactNumber(tout)} color="primary" />
        <KpiCard label="Total Tokens" value={compactNumber(total)} color="green" />
      </div>
      <div className="rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] p-[14px] font-[family-name:var(--font-mono-ui)] text-[11px] text-[var(--fg-muted)]">
        <div className="flex justify-between mb-[8px] uppercase tracking-[0.05em]">
          <span>Model</span>
          <span className="text-[var(--fg)] font-[family-name:var(--font-mono)] normal-case tracking-normal">
            {model}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="uppercase tracking-[0.05em]">Effective cost / 1M tok</span>
          <span className="text-[var(--fg)] font-[family-name:var(--font-mono)] normal-case tracking-normal tabular-nums">
            {total > 0 ? fmtCost(((cost?.cost || 0) / total) * 1_000_000) : "--"}
          </span>
        </div>
      </div>
    </div>
  );
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
