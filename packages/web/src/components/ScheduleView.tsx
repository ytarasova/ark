import { useState, useEffect, type FormEvent } from "react";
import { api } from "../hooks/useApi.js";
import { Modal } from "./Modal.js";

export function ScheduleView() {
  const [schedules, setSchedules] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [showNew, setShowNew] = useState(false);

  function load() {
    api.getSchedules().then((data) => {
      const list = data || [];
      setSchedules(list);
      if (selected) {
        const updated = list.find((s: any) => s.id === selected.id);
        setSelected(updated || (list.length ? list[0] : null));
      } else if (list.length) {
        setSelected(list[0]);
      }
    });
  }

  useEffect(() => { load(); }, []);

  async function handleToggle(sched: any) {
    if (sched.enabled) {
      await api.disableSchedule(sched.id);
    } else {
      await api.enableSchedule(sched.id);
    }
    load();
  }

  async function handleDelete(sched: any) {
    await api.deleteSchedule(sched.id);
    setSelected(null);
    load();
  }

  async function handleCreate(form: any) {
    await api.createSchedule(form);
    setShowNew(false);
    load();
  }

  function statusColor(enabled: boolean): string {
    return enabled ? "var(--green)" : "var(--label-quaternary)";
  }

  if (!schedules.length && !showNew) {
    return (
      <div className="empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.15, marginBottom: 16 }}>
          <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <div style={{ fontSize: 13, color: "var(--label-tertiary)", marginBottom: 12 }}>No schedules</div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          New Schedule
        </button>
        {showNew && <NewScheduleModal onClose={() => setShowNew(false)} onSubmit={handleCreate} />}
      </div>
    );
  }

  return (
    <>
      <div className="split-view">
        <div className="list-panel">
          <div style={{ padding: "8px 12px" }}>
            <button className="btn btn-primary" style={{ width: "100%", fontSize: 11 }} onClick={() => setShowNew(true)}>
              + New Schedule
            </button>
          </div>
          {schedules.map((s: any) => (
            <div
              key={s.id}
              className={`list-item${selected?.id === s.id ? " selected" : ""}`}
              onClick={() => setSelected(s)}
            >
              <div className="list-item-row">
                <span className="dot" style={{ background: statusColor(s.enabled), width: 8, height: 8 }} />
                <div className="list-item-name">{s.summary || s.id}</div>
              </div>
              <span className="source-badge">{s.cron}</span>
            </div>
          ))}
        </div>
        <div className="detail-content">
          {selected ? (
            <>
              <h2 className="detail-title">{selected.summary || selected.id}</h2>
              <div className="detail-section">
                <div className="detail-section-title">Schedule</div>
                <div className="detail-grid">
                  <div className="detail-label">ID</div>
                  <div className="detail-value" style={{ fontFamily: "var(--mono)" }}>{selected.id}</div>
                  <div className="detail-label">Cron</div>
                  <div className="detail-value" style={{ fontFamily: "var(--mono)" }}>{selected.cron}</div>
                  <div className="detail-label">Status</div>
                  <div className="detail-value">
                    <span className="dot" style={{ background: statusColor(selected.enabled), width: 8, height: 8, display: "inline-block", marginRight: 8 }} />
                    {selected.enabled ? "Enabled" : "Disabled"}
                  </div>
                  <div className="detail-label">Flow</div>
                  <div className="detail-value">{selected.flow || "bare"}</div>
                  {selected.repo && (
                    <>
                      <div className="detail-label">Repo</div>
                      <div className="detail-value" style={{ fontFamily: "var(--mono)" }}>{selected.repo}</div>
                    </>
                  )}
                  {selected.compute_name && (
                    <>
                      <div className="detail-label">Compute</div>
                      <div className="detail-value">{selected.compute_name}</div>
                    </>
                  )}
                  {selected.group_name && (
                    <>
                      <div className="detail-label">Group</div>
                      <div className="detail-value">{selected.group_name}</div>
                    </>
                  )}
                  {selected.last_run && (
                    <>
                      <div className="detail-label">Last Run</div>
                      <div className="detail-value">{new Date(selected.last_run).toLocaleString()}</div>
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
              <div className="detail-section">
                <div className="detail-section-title">Actions</div>
                <div className="btn-group">
                  <button className="btn btn-sm" onClick={() => handleToggle(selected)}>
                    {selected.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(selected)}>
                    Delete
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="empty"><div className="empty-text">Select a schedule</div></div>
          )}
        </div>
      </div>
      {showNew && <NewScheduleModal onClose={() => setShowNew(false)} onSubmit={handleCreate} />}
    </>
  );
}

function NewScheduleModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (form: any) => void }) {
  const [form, setForm] = useState({
    cron: "",
    flow: "",
    repo: ".",
    summary: "",
    compute_name: "",
    group_name: "",
  });

  function update(key: string, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.cron.trim()) return;
    onSubmit(form);
  }

  return (
    <Modal onClose={onClose}>
      <form className="modal" onSubmit={handleSubmit}>
        <div className="modal-title">New Schedule</div>
        <div className="form-group">
          <label className="form-label">Cron Expression *</label>
          <input
            className="form-input"
            autoFocus
            value={form.cron}
            onChange={(e) => update("cron", e.target.value)}
            placeholder="*/30 * * * *"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Summary</label>
          <input
            className="form-input"
            value={form.summary}
            onChange={(e) => update("summary", e.target.value)}
            placeholder="What should the scheduled agent do?"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Flow</label>
          <input
            className="form-input"
            value={form.flow}
            onChange={(e) => update("flow", e.target.value)}
            placeholder="bare"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Repository</label>
          <input
            className="form-input"
            value={form.repo}
            onChange={(e) => update("repo", e.target.value)}
            placeholder="/path/to/repo or ."
          />
        </div>
        <div className="form-group">
          <label className="form-label">Compute</label>
          <input
            className="form-input"
            value={form.compute_name}
            onChange={(e) => update("compute_name", e.target.value)}
            placeholder="Optional compute target"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Group</label>
          <input
            className="form-input"
            value={form.group_name}
            onChange={(e) => update("group_name", e.target.value)}
            placeholder="Optional group name"
          />
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Create Schedule</button>
        </div>
      </form>
    </Modal>
  );
}
