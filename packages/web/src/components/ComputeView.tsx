import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";

function ComputeActions({ compute, onAction }: { compute: any; onAction: (action: string) => void }) {
  const s = compute.status || "unknown";
  return (
    <div className="btn-group">
      {(s === "stopped" || s === "created" || s === "destroyed") && (
        <button className="btn btn-primary btn-sm" onClick={() => onAction("provision")}>Provision</button>
      )}
      {(s === "stopped" || s === "created") && (
        <button className="btn btn-success btn-sm" onClick={() => onAction("start")}>Start</button>
      )}
      {s === "running" && (
        <button className="btn btn-warning btn-sm" onClick={() => onAction("stop")}>Stop</button>
      )}
      {s === "running" && (
        <button className="btn btn-danger btn-sm" onClick={() => onAction("destroy")}>Destroy</button>
      )}
      {s !== "provisioning" && (
        <button className="btn btn-danger btn-sm" onClick={() => onAction("delete")}>Delete</button>
      )}
    </div>
  );
}

export function ComputeView() {
  const [computes, setComputes] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [actionMsg, setActionMsg] = useState<{ text: string; type: string } | null>(null);

  function refresh() {
    api.getCompute().then((data) => {
      setComputes(data || []);
      if (selected) {
        const updated = (data || []).find((c: any) => (c.name || c.id) === (selected.name || selected.id));
        setSelected(updated || null);
      }
    });
  }

  useEffect(() => {
    api.getCompute().then((data) => {
      setComputes(data || []);
      if (data?.length) setSelected(data[0]);
    });
  }, []);

  async function handleAction(action: string) {
    if (!selected) return;
    const name = selected.name || selected.id;
    let res: any;
    try {
      switch (action) {
        case "provision": res = await api.provisionCompute(name); break;
        case "start": res = await api.startCompute(name); break;
        case "stop": res = await api.stopCompute(name); break;
        case "destroy": res = await api.destroyCompute(name); break;
        case "delete": res = await api.deleteCompute(name); break;
        default: return;
      }
      if (res.ok !== false) {
        setActionMsg({ text: `${action} successful`, type: "success" });
        refresh();
      } else {
        setActionMsg({ text: res.message || "Action failed", type: "error" });
      }
    } catch (err: any) {
      setActionMsg({ text: err.message || "Action failed", type: "error" });
    }
    setTimeout(() => setActionMsg(null), 3000);
  }

  if (!computes.length) return <div className="empty"><div className="empty-icon">&#9729;</div><div className="empty-text">No compute targets</div></div>;

  function statusColor(status: string): string {
    switch (status) {
      case "running": return "#9ece6a";
      case "stopped": return "#f7768e";
      case "pending": case "provisioning": return "#e0af68";
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
            {/* Actions */}
            <div className="detail-section">
              <ComputeActions compute={selected} onAction={handleAction} />
              {actionMsg && (
                <div style={{ marginTop: 6, color: actionMsg.type === "error" ? "#f7768e" : "#9ece6a", fontSize: 13 }}>
                  {actionMsg.text}
                </div>
              )}
            </div>
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
