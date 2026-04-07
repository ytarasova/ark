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

  if (!agents.length) {
    return (
      <div className="empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.15, marginBottom: 16 }}>
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <div className="empty-text">No agents found</div>
      </div>
    );
  }

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
