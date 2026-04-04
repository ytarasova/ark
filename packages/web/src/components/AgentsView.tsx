import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";

export function AgentsView() {
  const [agents, setAgents] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    api.getAgents().then((data) => {
      setAgents(data || []);
      if (data?.length) setSelected(data[0]);
    });
  }, []);

  if (!agents.length) return <div className="empty"><div className="empty-icon">&#9881;</div><div className="empty-text">No agents found</div></div>;

  return (
    <div className="split-view">
      <div className="list-panel">
        {agents.map((a: any) => (
          <div
            key={a.name}
            className={`list-item${selected?.name === a.name ? " selected" : ""}`}
            onClick={() => setSelected(a)}
          >
            <div className="list-item-name">{a.name}</div>
            <span className="source-badge">{a.source || "builtin"}</span>
          </div>
        ))}
      </div>
      <div className="detail-content">
        {selected ? (
          <>
            <h2 className="detail-title">{selected.name}</h2>
            {selected.description && (
              <p className="detail-desc">{selected.description}</p>
            )}
            <div className="detail-section">
              <div className="detail-section-title">Configuration</div>
              <div className="detail-grid">
                <div className="detail-label">Model</div>
                <div className="detail-value">{selected.model || "-"}</div>
                <div className="detail-label">Max Turns</div>
                <div className="detail-value">{selected.max_turns ?? "-"}</div>
                <div className="detail-label">Permission</div>
                <div className="detail-value">{selected.permission_mode || "-"}</div>
              </div>
            </div>
            {selected.tools && selected.tools.length > 0 && (
              <div className="detail-section">
                <div className="detail-section-title">Tools</div>
                <div className="tag-list">
                  {selected.tools.map((t: string) => (
                    <span key={t} className="tag">{t}</span>
                  ))}
                </div>
              </div>
            )}
            {selected.skills && selected.skills.length > 0 && (
              <div className="detail-section">
                <div className="detail-section-title">Skills</div>
                <div className="tag-list">
                  {selected.skills.map((s: string) => (
                    <span key={s} className="tag tag-skill">{s}</span>
                  ))}
                </div>
              </div>
            )}
            {selected.system_prompt && (
              <div className="detail-section">
                <div className="detail-section-title">System Prompt</div>
                <div className="output-box">{selected.system_prompt}</div>
              </div>
            )}
          </>
        ) : (
          <div className="empty"><div className="empty-text">Select an agent</div></div>
        )}
      </div>
    </div>
  );
}
