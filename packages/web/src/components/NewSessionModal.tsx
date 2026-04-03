import { useState, type FormEvent } from "react";
import { Modal } from "./Modal.js";

interface NewSessionModalProps {
  onClose: () => void;
  onSubmit: (form: { summary: string; repo: string; flow: string; group_name: string }) => void;
}

export function NewSessionModal({ onClose, onSubmit }: NewSessionModalProps) {
  const [form, setForm] = useState({ summary: "", repo: ".", flow: "", group_name: "" });

  function update(key: string, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.summary.trim()) return;
    onSubmit(form);
  }

  return (
    <Modal onClose={onClose}>
      <form className="modal" onSubmit={handleSubmit}>
        <div className="modal-title">New Session</div>
        <div className="form-group">
          <label className="form-label">Summary *</label>
          <input
            className="form-input"
            autoFocus
            value={form.summary}
            onChange={(e) => update("summary", e.target.value)}
            placeholder="What should the agent work on?"
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
          <label className="form-label">Flow</label>
          <input
            className="form-input"
            value={form.flow}
            onChange={(e) => update("flow", e.target.value)}
            placeholder="default"
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
          <button type="submit" className="btn btn-primary">Create Session</button>
        </div>
      </form>
    </Modal>
  );
}
