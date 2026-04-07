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

function SessionActions({ session, onAction, onSend }: { session: any; onAction: (action: string) => void; onSend: (msg: string) => void }) {
  const s = session.status;
  const [sendMsg, setSendMsg] = useState("");
  const [showSend, setShowSend] = useState(false);
  return (
    <div>
      <div className="btn-group">
        {(s === "ready" || s === "pending") && (
          <button className="btn btn-primary btn-sm" onClick={() => onAction("dispatch")}>Dispatch</button>
        )}
        {(s === "running" || s === "waiting") && (
          <button className="btn btn-warning btn-sm" onClick={() => onAction("stop")}>Stop</button>
        )}
        {(s === "running" || s === "waiting") && (
          <button className="btn btn-sm" onClick={() => onAction("pause")}>Pause</button>
        )}
        {(s === "running" || s === "waiting") && (
          <button className="btn btn-sm" onClick={() => onAction("interrupt")}>Interrupt</button>
        )}
        {(s === "running" || s === "waiting" || s === "blocked") && (
          <button className="btn btn-primary btn-sm" onClick={() => onAction("advance")}>Advance</button>
        )}
        {(s === "running" || s === "waiting" || s === "blocked") && (
          <button className="btn btn-success btn-sm" onClick={() => onAction("complete")}>Complete</button>
        )}
        {(s === "stopped" || s === "failed") && (
          <button className="btn btn-success btn-sm" onClick={() => onAction("restart")}>Restart</button>
        )}
        {s !== "deleting" && (
          <button className="btn btn-sm" onClick={() => onAction("fork")}>Fork</button>
        )}
        {(s === "running" || s === "waiting") && (
          <button className="btn btn-sm" onClick={() => setShowSend(!showSend)}>Send</button>
        )}
        {(s === "completed" || s === "stopped" || s === "failed") && (
          <button className="btn btn-sm" onClick={() => onAction("archive")}>Archive</button>
        )}
        {s === "archived" && (
          <button className="btn btn-sm" onClick={() => onAction("restore")}>Restore</button>
        )}
        {s !== "deleting" && (
          <button className="btn btn-danger btn-sm" onClick={() => onAction("delete")}>Delete</button>
        )}
        {s === "deleting" && (
          <button className="btn btn-sm" onClick={() => onAction("undelete")}>Undelete</button>
        )}
      </div>
      {showSend && (
        <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
          <input
            className="input input-sm"
            style={{ flex: 1 }}
            placeholder="Message to agent..."
            value={sendMsg}
            onChange={(e) => setSendMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && sendMsg.trim()) {
                onSend(sendMsg.trim());
                setSendMsg("");
                setShowSend(false);
              }
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={!sendMsg.trim()}
            onClick={() => {
              if (sendMsg.trim()) {
                onSend(sendMsg.trim());
                setSendMsg("");
                setShowSend(false);
              }
            }}
          >Send</button>
        </div>
      )}
    </div>
  );
}

export function SessionDetail({ sessionId, onClose, onToast, readOnly }: SessionDetailProps) {
  const [detail, setDetail] = useState<any>(null);
  const [output, setOutput] = useState("");
  const outputRef = useRef<HTMLDivElement>(null);
  const [diffData, setDiffData] = useState<any>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [showPRForm, setShowPRForm] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prDraft, setPrDraft] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [todos, setTodos] = useState<any[]>([]);
  const [newTodo, setNewTodo] = useState("");
  const [verifyResult, setVerifyResult] = useState<any>(null);
  const [flowStages, setFlowStages] = useState<any[]>([]);

  // Load todos
  useEffect(() => {
    if (!sessionId) return;
    api.getTodos(sessionId).then((data) => setTodos(Array.isArray(data) ? data : [])).catch(() => {});
  }, [sessionId]);

  // Load detail
  useEffect(() => {
    if (!sessionId) return;
    api.getSession(sessionId).then(setDetail);
  }, [sessionId]);

  // Load flow stages for pipeline visualization
  useEffect(() => {
    if (!detail?.session?.flow) { setFlowStages([]); return; }
    api.getFlowDetail(detail.session.flow)
      .then((d: any) => setFlowStages(d.stages || []))
      .catch(() => setFlowStages([]));
  }, [detail?.session?.flow]);

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
      case "pause": res = await api.pause(sessionId); break;
      case "interrupt": res = await api.interrupt(sessionId); break;
      case "advance": res = await api.advance(sessionId); break;
      case "complete": res = await api.complete(sessionId); break;
      case "fork": res = await api.fork(sessionId); break;
      case "archive": res = await api.archive(sessionId); break;
      case "restore": res = await api.restore(sessionId); break;
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

  async function handlePreviewDiff() {
    const data = await api.worktreeDiff(sessionId);
    setDiffData(data);
    setShowDiff(true);
  }

  async function handleCreatePR() {
    const res = await api.worktreeCreatePR(sessionId, {
      title: prTitle || undefined,
      draft: prDraft || undefined,
    });
    if (res.ok !== false) {
      onToast("PR created", "success");
      if (res.pr_url) setPrUrl(res.pr_url);
      setShowPRForm(false);
      const d = await api.getSession(sessionId);
      setDetail(d);
    } else {
      onToast(res.message || "PR creation failed", "error");
    }
  }

  async function handleAddTodo() {
    if (!newTodo.trim()) return;
    const res = await api.addTodo(sessionId, newTodo.trim());
    if (res.ok !== false && res.todo) {
      setTodos([...todos, res.todo]);
      setNewTodo("");
    } else {
      onToast("Failed to add todo", "error");
    }
  }

  async function handleToggleTodo(id: number) {
    const res = await api.toggleTodo(id);
    if (res.ok !== false && res.todo) {
      setTodos(todos.map(t => t.id === id ? res.todo : t));
    }
  }

  async function handleDeleteTodo(id: number) {
    const res = await api.deleteTodo(id);
    if (res.ok !== false) {
      setTodos(todos.filter(t => t.id !== id));
    }
  }

  async function handleRunVerification() {
    const result = await api.runVerification(sessionId);
    setVerifyResult(result);
    if (result.ok) {
      onToast("Verification passed", "success");
    } else {
      onToast("Verification failed", "error");
    }
  }

  async function handleSend(message: string) {
    const res = await api.send(sessionId, message);
    if (res.ok !== false) {
      onToast("Message sent", "success");
    } else {
      onToast(res.message || "Send failed", "error");
    }
  }

  if (!detail || !detail.session) {
    return (
      <div className="detail-panel open">
        <div className="detail-header">
          <span style={{ fontSize: 12, color: "var(--label-tertiary)" }}>Loading...</span>
          <button className="detail-close" onClick={onClose}>{"\u2715"}</button>
        </div>
      </div>
    );
  }

  const s = detail.session;
  const events = detail.events || [];

  // Channel port: deterministic from session ID
  const channelPort = 19200 + (parseInt(s.id.replace("s-", ""), 16) % 10000);

  // Token formatting helper
  function humanTokens(n: number): string {
    if (!n) return "0";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  // Cost formatting helper
  function formatCost(cost: number): string {
    if (cost === 0) return "$0.00";
    if (cost < 0.01) return "<$0.01";
    return `$${cost.toFixed(2)}`;
  }

  return (
    <div className="detail-panel open">
      <div className="detail-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge status={s.status} />
          <span style={{ fontWeight: 600, fontSize: 13 }}>{s.id}</span>
        </div>
        <button className="detail-close" onClick={onClose}>{"\u2715"}</button>
      </div>
      <div className="detail-body">
        {/* Actions */}
        {!readOnly && (
          <div className="detail-section">
            <SessionActions session={s} onAction={handleAction} onSend={handleSend} />
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

        {/* Flow Pipeline */}
        {flowStages.length > 1 && s.stage && (
          <div className="detail-section">
            <div className="detail-section-title">Flow Pipeline</div>
            <div style={{ display: "flex", gap: 0, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
              {flowStages.map((st: any, i: number) => {
                const isCurrent = st.name === s.stage;
                const currentIdx = flowStages.findIndex((x: any) => x.name === s.stage);
                const isPast = currentIdx > i;
                return (
                  <span key={st.name} style={{ display: "inline-flex", alignItems: "center" }}>
                    {i > 0 && <span style={{ color: "var(--label-quaternary)", margin: "0 4px" }}>&gt;</span>}
                    <span style={{
                      color: isCurrent ? "var(--tint)" : isPast ? "var(--green)" : "var(--label-quaternary)",
                      fontWeight: isCurrent ? 700 : 400,
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                    }}>
                      {isCurrent ? `[${st.name}]` : st.name}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Completion Summary */}
        {s.config?.completion_summary && (
          <div className="detail-section">
            <div className="detail-section-title">Completion Summary</div>
            <div style={{ fontSize: 12, color: "var(--label-secondary)", lineHeight: 1.6 }}>{s.config.completion_summary}</div>
          </div>
        )}

        {/* Token Usage & Cost */}
        {s.config?.usage && (
          <div className="detail-section">
            <div className="detail-section-title">Usage</div>
            <div className="detail-grid">
              {s.config.usage.input_tokens != null && (
                <>
                  <span className="detail-label">Input tokens</span>
                  <span className="detail-value" style={{ fontFamily: "var(--mono)" }}>{humanTokens(s.config.usage.input_tokens)}</span>
                </>
              )}
              {s.config.usage.output_tokens != null && (
                <>
                  <span className="detail-label">Output tokens</span>
                  <span className="detail-value" style={{ fontFamily: "var(--mono)" }}>{humanTokens(s.config.usage.output_tokens)}</span>
                </>
              )}
              {s.config.usage.cache_read_input_tokens != null && (
                <>
                  <span className="detail-label">Cache read</span>
                  <span className="detail-value" style={{ fontFamily: "var(--mono)" }}>{humanTokens(s.config.usage.cache_read_input_tokens)}</span>
                </>
              )}
              {s.config.usage.total_tokens != null && (
                <>
                  <span className="detail-label">Total tokens</span>
                  <span className="detail-value" style={{ fontFamily: "var(--mono)" }}>{humanTokens(s.config.usage.total_tokens)}</span>
                </>
              )}
              {s.config.usage.total_cost != null && s.config.usage.total_cost > 0 && (
                <>
                  <span className="detail-label">Cost</span>
                  <span className="detail-value" style={{ color: "var(--yellow)", fontFamily: "var(--mono)" }}>{formatCost(s.config.usage.total_cost)}</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Preview Changes / Create PR */}
        {s.workdir && s.status !== "deleting" && (
          <div className="detail-section">
            <div className="btn-group">
              <button className="btn btn-sm" onClick={handlePreviewDiff}>Preview Changes</button>
              {!readOnly && (
                <button className="btn btn-sm" onClick={() => { setPrTitle(s.summary || ""); setShowPRForm(!showPRForm); }}>Create PR</button>
              )}
            </div>
            {prUrl && (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                PR: <a href={prUrl} target="_blank" rel="noopener noreferrer">{prUrl}</a>
              </div>
            )}
            {s.pr_url && !prUrl && (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                PR: <a href={s.pr_url} target="_blank" rel="noopener noreferrer">{s.pr_url}</a>
              </div>
            )}
            {showPRForm && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  className="input input-sm"
                  placeholder="PR title"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                />
                <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4, color: "var(--label-secondary)" }}>
                  <input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} />
                  Draft PR
                </label>
                <div className="btn-group">
                  <button className="btn btn-primary btn-sm" onClick={handleCreatePR}>Submit PR</button>
                  <button className="btn btn-sm" onClick={() => setShowPRForm(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Diff Preview */}
        {showDiff && diffData && (
          <div className="detail-section">
            <div className="detail-section-title">
              Changes: {diffData.branch} vs {diffData.baseBranch}
              <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setShowDiff(false)}>Close</button>
            </div>
            <div style={{ fontSize: 11, color: "var(--label-tertiary)", marginBottom: 6, fontFamily: "var(--mono)" }}>
              {diffData.filesChanged} files changed, +{diffData.insertions} -{diffData.deletions}
            </div>
            {diffData.modifiedSinceReview?.length > 0 && (
              <div style={{ color: "var(--yellow)", fontSize: 11, marginBottom: 6 }}>
                Modified since last review: {diffData.modifiedSinceReview.join(", ")}
              </div>
            )}
            <pre className="output-box" style={{ maxHeight: 400, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 11 }}>
              {diffData.stat || diffData.message || "No changes"}
            </pre>
          </div>
        )}

        {/* Todos */}
        <div className="detail-section">
          <div className="detail-section-title">
            Todos
            {!readOnly && (
              <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={handleRunVerification}>Run Verification</button>
            )}
          </div>
          {todos.length === 0 && <div style={{ fontSize: 12, color: "var(--label-tertiary)" }}>No todos</div>}
          {todos.map((t: any) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              {!readOnly && (
                <input
                  type="checkbox"
                  checked={t.done}
                  onChange={() => handleToggleTodo(t.id)}
                />
              )}
              <span style={{ textDecoration: t.done ? "line-through" : "none", flex: 1, fontSize: 12, color: t.done ? "var(--label-tertiary)" : "var(--label)" }}>
                {t.content}
              </span>
              {!readOnly && (
                <button className="btn btn-sm btn-danger" style={{ padding: "0 4px", fontSize: 10 }} onClick={() => handleDeleteTodo(t.id)}>x</button>
              )}
            </div>
          ))}
          {!readOnly && (
            <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
              <input
                className="input input-sm"
                style={{ flex: 1 }}
                placeholder="Add a todo..."
                value={newTodo}
                onChange={(e) => setNewTodo(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAddTodo(); }}
              />
              <button className="btn btn-sm" disabled={!newTodo.trim()} onClick={handleAddTodo}>Add</button>
            </div>
          )}
        </div>

        {/* Verification Result */}
        {verifyResult && (
          <div className="detail-section">
            <div className="detail-section-title">
              Verification: {verifyResult.ok ? <span style={{ color: "var(--green)" }}>PASSED</span> : <span style={{ color: "var(--red)" }}>FAILED</span>}
            </div>
            {!verifyResult.todosResolved && (
              <div style={{ fontSize: 12, color: "var(--red)", marginBottom: 4 }}>
                Pending todos: {verifyResult.pendingTodos?.join(", ")}
              </div>
            )}
            {verifyResult.scriptResults?.map((r: any, i: number) => (
              <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: r.passed ? "var(--green)" : "var(--red)", fontFamily: "var(--mono)", fontSize: 10 }}>{r.passed ? "[PASS]" : "[FAIL]"}</span>{" "}
                <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{r.script}</code>
                {!r.passed && r.output && (
                  <pre style={{ fontSize: 10, color: "var(--label-tertiary)", marginTop: 2, whiteSpace: "pre-wrap", fontFamily: "var(--mono)" }}>{r.output.slice(0, 500)}</pre>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Files Changed */}
        {s.config?.filesChanged?.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-title">Files Changed ({s.config.filesChanged.length})</div>
            <div style={{ maxHeight: 200, overflowY: "auto" }}>
              {s.config.filesChanged.map((f: string) => (
                <div key={f} style={{ fontSize: 11, color: "var(--label-secondary)", padding: "1px 0", fontFamily: "var(--mono)" }}>{f}</div>
              ))}
            </div>
          </div>
        )}

        {/* Commits */}
        {s.config?.commits?.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-title">Commits ({s.config.commits.length})</div>
            {s.config.commits.map((c: string) => {
              const shortSha = c.slice(0, 7);
              const ghBase = s.config?.github_url;
              const commitUrl = ghBase ? `${ghBase}/commit/${c}` : null;
              return (
                <div key={c} style={{ fontSize: 11, color: "var(--label-secondary)", fontFamily: "var(--mono)", padding: "1px 0" }}>
                  {commitUrl ? (
                    <a href={commitUrl} target="_blank" rel="noopener noreferrer">{shortSha}</a>
                  ) : shortSha}
                </div>
              );
            })}
          </div>
        )}

        {/* Channel Port */}
        {(s.status === "running" || s.status === "waiting") && s.session_id && (
          <div className="detail-section">
            <div style={{ fontSize: 11, color: "var(--green)", fontFamily: "var(--mono)" }}>
              Channel: port {channelPort}
            </div>
          </div>
        )}

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
