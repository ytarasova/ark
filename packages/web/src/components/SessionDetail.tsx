import { useState, useEffect, useRef } from "react";
import { StatusBadge } from "./StatusDot.js";
import { api } from "../hooks/useApi.js";
import { relTime } from "../util.js";

interface SessionDetailProps {
  sessionId: string;
  onClose: () => void;
  onToast: (msg: string, type: string) => void;
  readOnly: boolean;
}

function SessionActions({ session, onAction }: { session: any; onAction: (action: string) => void }) {
  const s = session.status;
  return (
    <div className="btn-group">
      {(s === "ready" || s === "pending") && (
        <button className="btn btn-primary btn-sm" onClick={() => onAction("dispatch")}>Dispatch</button>
      )}
      {(s === "running" || s === "waiting") && (
        <button className="btn btn-warning btn-sm" onClick={() => onAction("stop")}>Stop</button>
      )}
      {(s === "stopped" || s === "failed") && (
        <button className="btn btn-success btn-sm" onClick={() => onAction("restart")}>Restart</button>
      )}
      {s !== "deleting" && (
        <button className="btn btn-danger btn-sm" onClick={() => onAction("delete")}>Delete</button>
      )}
      {s === "deleting" && (
        <button className="btn btn-sm" onClick={() => onAction("undelete")}>Undelete</button>
      )}
    </div>
  );
}

export function SessionDetail({ sessionId, onClose, onToast, readOnly }: SessionDetailProps) {
  const [detail, setDetail] = useState<any>(null);
  const [output, setOutput] = useState("");
  const outputRef = useRef<HTMLDivElement>(null);

  // Load detail
  useEffect(() => {
    if (!sessionId) return;
    api.getSession(sessionId).then(setDetail);
  }, [sessionId]);

  // Poll output for running sessions
  useEffect(() => {
    if (!detail || !detail.session) return;
    if (detail.session.status !== "running" && detail.session.status !== "waiting") return;
    let active = true;
    function poll() {
      if (!active) return;
      api.getOutput(sessionId)
        .then((d) => { if (active && d.output) setOutput(d.output); })
        .catch(() => {});
    }
    poll();
    const iv = setInterval(poll, 2000);
    return () => { active = false; clearInterval(iv); };
  }, [detail?.session?.status, sessionId]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  async function handleAction(action: string) {
    let res: any;
    switch (action) {
      case "dispatch": res = await api.dispatch(sessionId); break;
      case "stop": res = await api.stop(sessionId); break;
      case "restart": res = await api.restart(sessionId); break;
      case "delete": res = await api.deleteSession(sessionId); break;
      case "undelete": res = await api.undelete(sessionId); break;
      default: return;
    }
    if (res.ok !== false) {
      onToast(`${action} successful`, "success");
      const d = await api.getSession(sessionId);
      setDetail(d);
    } else {
      onToast(res.message || "Action failed", "error");
    }
  }

  if (!detail || !detail.session) {
    return (
      <div className="detail-panel open">
        <div className="detail-header">
          <span>Loading...</span>
          <button className="detail-close" onClick={onClose}>{"\u2715"}</button>
        </div>
      </div>
    );
  }

  const s = detail.session;
  const events = detail.events || [];

  return (
    <div className="detail-panel open">
      <div className="detail-header">
        <div>
          <StatusBadge status={s.status} />
          <span style={{ marginLeft: 8, fontWeight: 600 }}>{s.id}</span>
        </div>
        <button className="detail-close" onClick={onClose}>{"\u2715"}</button>
      </div>
      <div className="detail-body">
        {/* Actions */}
        {!readOnly && (
          <div className="detail-section">
            <SessionActions session={s} onAction={handleAction} />
          </div>
        )}

        {/* Metadata */}
        <div className="detail-section">
          <div className="detail-section-title">Details</div>
          <div className="detail-grid">
            <span className="detail-label">Summary</span>
            <span className="detail-value">{s.summary || "-"}</span>
            <span className="detail-label">Agent</span>
            <span className="detail-value">{s.agent || "-"}</span>
            <span className="detail-label">Flow</span>
            <span className="detail-value">{s.pipeline || s.flow || "-"}</span>
            <span className="detail-label">Stage</span>
            <span className="detail-value">{s.stage || "-"}</span>
            <span className="detail-label">Repo</span>
            <span className="detail-value">{s.repo || "-"}</span>
            <span className="detail-label">Branch</span>
            <span className="detail-value">{s.branch || "-"}</span>
            <span className="detail-label">Group</span>
            <span className="detail-value">{s.group_name || "-"}</span>
            <span className="detail-label">Created</span>
            <span className="detail-value">{relTime(s.created_at)}</span>
            <span className="detail-label">Updated</span>
            <span className="detail-value">{relTime(s.updated_at)}</span>
          </div>
        </div>

        {/* Output */}
        {output && (
          <div className="detail-section">
            <div className="detail-section-title">Live Output</div>
            <div className="output-box" ref={outputRef}>{output}</div>
          </div>
        )}

        {/* Events */}
        {events.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-title">Events ({events.length})</div>
            <div className="timeline">
              {events.slice(-50).reverse().map((ev: any, i: number) => (
                <div key={i} className="timeline-item">
                  <span className="timeline-time">{relTime(ev.created_at)}</span>
                  <span className="timeline-event">
                    <b>{ev.type}</b>
                    {ev.data ? " " + (typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data)).slice(0, 120) : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
