import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";

type Tab = "skills" | "recipes";

export function ToolsView() {
  const [tab, setTab] = useState<Tab>("skills");
  const [skills, setSkills] = useState<any[]>([]);
  const [recipes, setRecipes] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    api.getSkills().then((d) => setSkills(d || []));
    api.getRecipes().then((d) => setRecipes(d || []));
  }, []);

  const items = tab === "skills" ? skills : recipes;

  function handleSelect(item: any) {
    setSelected(item);
  }

  function handleTab(t: Tab) {
    setTab(t);
    setSelected(null);
  }

  return (
    <div>
      <div className="tab-bar">
        <button className={`tab-btn${tab === "skills" ? " active" : ""}`} onClick={() => handleTab("skills")}>Skills</button>
        <button className={`tab-btn${tab === "recipes" ? " active" : ""}`} onClick={() => handleTab("recipes")}>Recipes</button>
      </div>
      <div className="split-view">
        <div className="list-panel">
          {items.length === 0 && (
            <div className="empty" style={{ padding: "32px 16px" }}>
              <div className="empty-text">No {tab} found</div>
            </div>
          )}
          {items.map((item: any) => (
            <div
              key={item.name}
              className={`list-item${selected?.name === item.name ? " selected" : ""}`}
              onClick={() => handleSelect(item)}
            >
              <div className="list-item-name">{item.name}</div>
              <span className="source-badge">{item.source || "builtin"}</span>
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
              {tab === "skills" && (
                <div className="detail-section">
                  <div className="detail-section-title">Content</div>
                  <div className="output-box">{selected.content || selected.prompt || "(no content)"}</div>
                </div>
              )}
              {tab === "recipes" && (
                <>
                  <div className="detail-section">
                    <div className="detail-section-title">Configuration</div>
                    <div className="detail-grid">
                      <div className="detail-label">Flow</div>
                      <div className="detail-value">{selected.flow || "-"}</div>
                      <div className="detail-label">Agent</div>
                      <div className="detail-value">{selected.agent || "-"}</div>
                      <div className="detail-label">Repo</div>
                      <div className="detail-value">{selected.repo || "-"}</div>
                    </div>
                  </div>
                  {selected.variables && Object.keys(selected.variables).length > 0 && (
                    <div className="detail-section">
                      <div className="detail-section-title">Variables</div>
                      <div className="detail-grid">
                        {Object.entries(selected.variables).map(([k, v]) => (
                          <div key={k} style={{ display: "contents" }}>
                            <div className="detail-label">{k}</div>
                            <div className="detail-value">{String(v)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selected.summary && (
                    <div className="detail-section">
                      <div className="detail-section-title">Summary</div>
                      <div className="output-box">{selected.summary}</div>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="empty"><div className="empty-text">Select a {tab === "skills" ? "skill" : "recipe"}</div></div>
          )}
        </div>
      </div>
    </div>
  );
}
