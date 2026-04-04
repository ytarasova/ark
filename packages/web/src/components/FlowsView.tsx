import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";

export function FlowsView() {
  const [flows, setFlows] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    api.getFlows().then((data) => {
      setFlows(data || []);
      if (data?.length) setSelected(data[0]);
    });
  }, []);

  if (!flows.length) return <div className="empty"><div className="empty-icon">&#8644;</div><div className="empty-text">No flows found</div></div>;

  return (
    <div className="split-view">
      <div className="list-panel">
        {flows.map((f: any) => {
          const stageCount = f.stages?.length ?? 0;
          return (
            <div
              key={f.name}
              className={`list-item${selected?.name === f.name ? " selected" : ""}`}
              onClick={() => setSelected(f)}
            >
              <div className="list-item-name">{f.name}</div>
              <span className="source-badge">{stageCount} stage{stageCount !== 1 ? "s" : ""}</span>
            </div>
          );
        })}
      </div>
      <div className="detail-content">
        {selected ? (
          <>
            <h2 className="detail-title">{selected.name}</h2>
            {selected.description && (
              <p className="detail-desc">{selected.description}</p>
            )}
            {selected.stages && selected.stages.length > 0 && (
              <div className="detail-section">
                <div className="detail-section-title">Stages</div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th>Agent</th>
                      <th>Gate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.stages.map((s: any, i: number) => (
                      <tr key={i}>
                        <td style={{ color: "#565f89" }}>{i + 1}</td>
                        <td style={{ fontWeight: 600 }}>{s.name}</td>
                        <td>{s.agent || "-"}</td>
                        <td>
                          <span className={`gate-badge gate-${s.gate || "auto"}`}>
                            {s.gate || "auto"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="empty"><div className="empty-text">Select a flow</div></div>
        )}
      </div>
    </div>
  );
}
