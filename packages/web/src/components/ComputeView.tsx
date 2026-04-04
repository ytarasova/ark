import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";

export function ComputeView() {
  const [computes, setComputes] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    api.getCompute().then((data) => {
      setComputes(data || []);
      if (data?.length) setSelected(data[0]);
    });
  }, []);

  if (!computes.length) return <div className="empty"><div className="empty-icon">&#9729;</div><div className="empty-text">No compute targets</div></div>;

  function statusColor(status: string): string {
    switch (status) {
      case "running": return "#9ece6a";
      case "stopped": return "#f7768e";
      case "pending": return "#e0af68";
      default: return "#787fa0";
    }
  }

  return (
    <div className="split-view">
      <div className="list-panel">
        {computes.map((c: any) => (
          <div
            key={c.name || c.id}
            className={`list-item${selected === c ? " selected" : ""}`}
            onClick={() => setSelected(c)}
          >
            <div className="list-item-row">
              <span className="dot" style={{ background: statusColor(c.status || "unknown"), width: 8, height: 8 }} />
              <div className="list-item-name">{c.name || c.id}</div>
            </div>
            <span className="source-badge">{c.provider || c.type || "local"}</span>
          </div>
        ))}
      </div>
      <div className="detail-content">
        {selected ? (
          <>
            <h2 className="detail-title">{selected.name || selected.id}</h2>
            <div className="detail-section">
              <div className="detail-section-title">Details</div>
              <div className="detail-grid">
                <div className="detail-label">Provider</div>
                <div className="detail-value">{selected.provider || selected.type || "-"}</div>
                <div className="detail-label">Status</div>
                <div className="detail-value">
                  <span className="dot" style={{ background: statusColor(selected.status || "unknown"), width: 8, height: 8, display: "inline-block", marginRight: 8 }} />
                  {selected.status || "unknown"}
                </div>
                {selected.ip && (
                  <>
                    <div className="detail-label">IP</div>
                    <div className="detail-value" style={{ fontFamily: "monospace" }}>{selected.ip}</div>
                  </>
                )}
                {selected.instanceType && (
                  <>
                    <div className="detail-label">Instance</div>
                    <div className="detail-value">{selected.instanceType}</div>
                  </>
                )}
                {selected.region && (
                  <>
                    <div className="detail-label">Region</div>
                    <div className="detail-value">{selected.region}</div>
                  </>
                )}
                {selected.created_at && (
                  <>
                    <div className="detail-label">Created</div>
                    <div className="detail-value">{new Date(selected.created_at).toLocaleString()}</div>
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="empty"><div className="empty-text">Select a compute target</div></div>
        )}
      </div>
    </div>
  );
}
