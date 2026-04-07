import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { fmtCost } from "../util.js";

export function CostsView() {
  const [costs, setCosts] = useState<any>(null);

  useEffect(() => {
    api.getCosts().then(setCosts);
  }, []);

  if (!costs) return <div className="empty"><div className="empty-text">Loading costs...</div></div>;

  const byModel: Record<string, { cost: number; count: number }> = {};
  for (const s of costs.sessions || []) {
    const m = s.model || "unknown";
    if (!byModel[m]) byModel[m] = { cost: 0, count: 0 };
    byModel[m].cost += s.cost;
    byModel[m].count++;
  }

  return (
    <div>
      <div className="cost-hero">
        <div className="cost-total">{fmtCost(costs.total || 0)}</div>
        <div className="cost-subtitle">{(costs.sessions || []).length} sessions with usage data</div>
      </div>
      <div className="cost-grid">
        {Object.entries(byModel).map(([model, data]) => (
          <div key={model} className="cost-card">
            <div className="cost-model">{model}</div>
            <div className="cost-amount">{fmtCost(data.cost)}</div>
            <div className="cost-count">{data.count} sessions</div>
          </div>
        ))}
      </div>
      {(costs.sessions || []).length > 0 && (
        <div>
          <div style={{ color: "var(--label-quaternary)", fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 8 }}>
            Top Sessions by Cost
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Model</th>
                <th style={{ textAlign: "right" }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {(costs.sessions || []).slice(0, 20).map((s: any, i: number) => (
                <tr key={i}>
                  <td>{s.summary || s.sessionId}</td>
                  <td>{s.model || "-"}</td>
                  <td style={{ textAlign: "right", color: "var(--green)", fontWeight: 600, fontFamily: "var(--mono)", fontSize: 12 }}>{fmtCost(s.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
