import { useState, useEffect, useRef } from "react";
import { StatusBadge } from "./StatusDot.js";
import { api } from "../hooks/useApi.js";
import { relTime } from "../util.js";
import { cn } from "../lib/utils.js";

interface SessionDetailProps {
  sessionId: string;
  onClose: () => void;
  onToast: (msg: string, type: string) => void;
  readOnly: boolean;
}

// Shared button styles
const btnBase = "glass-btn inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium cursor-pointer text-label active:scale-[0.97] transition-all duration-200 whitespace-nowrap";
const btnSm = "px-2.5 py-1";
const btnPrimary = "bg-tint border-none text-white font-semibold shadow-[0_2px_12px_rgba(124,106,239,0.3),inset_0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110";
const btnDanger = "text-danger border-danger/20 bg-transparent hover:bg-danger-dim hover:border-danger/30";
const btnSuccess = "text-success border-success/20 bg-transparent hover:bg-success-dim hover:border-success/30";
const btnWarning = "text-warning border-warning/20 bg-transparent hover:bg-warning-dim hover:border-warning/30";
const inputBase = "glass-input rounded-lg px-3 py-[7px] text-[13px] text-label placeholder:text-label-quaternary outline-none focus:border-tint focus:shadow-[0_0_0_3px_var(--color-tint-dim)] transition-all duration-200";
const inputSm = "px-2.5 py-1 text-xs";

function SessionActions({ session, onAction, onSend }: { session: any; onAction: (action: string) => void; onSend: (msg: string) => void }) {
  const s = session.status;
  const [sendMsg, setSendMsg] = useState("");
  const [showSend, setShowSend] = useState(false);
  return (
    <div>
      <div className="flex gap-1.5 flex-wrap">
        {(s === "ready" || s === "pending") && (
          <button className={cn(btnBase, btnSm, btnPrimary)} onClick={() => onAction("dispatch")}>Dispatch</button>
        )}
        {(s === "running" || s === "waiting") && (
          <button className={cn(btnBase, btnSm, btnWarning)} onClick={() => onAction("stop")}>Stop</button>
        )}
        {(s === "running" || s === "waiting") && (
          <button className={cn(btnBase, btnSm)} onClick={() => onAction("pause")}>Pause</button>
        )}
        {(s === "running" || s === "waiting") && (
          <button className={cn(btnBase, btnSm)} onClick={() => onAction("interrupt")}>Interrupt</button>
        )}
        {(s === "running" || s === "waiting" || s === "blocked") && (
          <button className={cn(btnBase, btnSm, btnPrimary)} onClick={() => onAction("advance")}>Advance</button>
        )}
        {(s === "running" || s === "waiting" || s === "blocked") && (
          <button className={cn(btnBase, btnSm, btnSuccess)} onClick={() => onAction("complete")}>Complete</button>
        )}
        {(s === "stopped" || s === "failed") && (
          <button className={cn(btnBase, btnSm, btnSuccess)} onClick={() => onAction("restart")}>Restart</button>
        )}
        {s !== "deleting" && (
          <button className={cn(btnBase, btnSm)} onClick={() => onAction("fork")}>Fork</button>
        )}
        {(s === "running" || s === "waiting") && (
          <button className={cn(btnBase, btnSm)} onClick={() => setShowSend(!showSend)}>Send</button>
        )}
        {(s === "completed" || s === "stopped" || s === "failed") && (
          <button className={cn(btnBase, btnSm)} onClick={() => onAction("archive")}>Archive</button>
        )}
        {s === "archived" && (
          <button className={cn(btnBase, btnSm)} onClick={() => onAction("restore")}>Restore</button>
        )}
        {s !== "deleting" && (
          <button className={cn(btnBase, btnSm, btnDanger)} onClick={() => onAction("delete")}>Delete</button>
        )}
        {s === "deleting" && (
          <button className={cn(btnBase, btnSm)} onClick={() => onAction("undelete")}>Undelete</button>
        )}
      </div>
      {showSend && (
        <div className="flex gap-1 mt-1.5">
          <input
            className={cn(inputBase, inputSm, "flex-1")}
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
            className={cn(btnBase, btnSm, btnPrimary)}
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
      <div className="fixed top-0 right-0 w-[560px] h-screen glass-surface-xl bg-glass-dark border-l border-white/8 flex flex-col z-[100] shadow-glass-elevated translate-x-0 transition-transform duration-300">
        <div className="h-[52px] px-5 border-b border-white/8 flex justify-between items-center shrink-0">
          <span className="text-xs text-label-tertiary">Loading...</span>
          <button className="glass-btn w-7 h-7 flex items-center justify-center rounded-lg text-sm text-label-tertiary cursor-pointer hover:text-label hover:bg-white/8 transition-all duration-200" onClick={onClose}>{"\u2715"}</button>
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
    <div className="fixed top-0 right-0 w-[560px] h-screen glass-surface-xl bg-glass-dark border-l border-white/8 flex flex-col z-[100] shadow-glass-elevated translate-x-0 transition-transform duration-300">
      <div className="h-[52px] px-5 border-b border-white/8 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <StatusBadge status={s.status} />
          <span className="font-semibold text-[13px]">{s.id}</span>
        </div>
        <button className="glass-btn w-7 h-7 flex items-center justify-center rounded-lg text-sm text-label-tertiary cursor-pointer hover:text-label hover:bg-white/8 transition-all duration-200" onClick={onClose}>{"\u2715"}</button>
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        {/* Actions */}
        {!readOnly && (
          <div className="mb-5">
            <SessionActions session={s} onAction={handleAction} onSend={handleSend} />
          </div>
        )}

        {/* Metadata */}
        <div className="mb-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Details</div>
          <div className="grid grid-cols-[100px_1fr] gap-x-3.5 gap-y-1.5 text-xs">
            <span className="text-label-tertiary font-medium">Summary</span>
            <span className="text-label break-all">{s.summary || "-"}</span>
            <span className="text-label-tertiary font-medium">Agent</span>
            <span className="text-label break-all">{s.agent || "-"}</span>
            <span className="text-label-tertiary font-medium">Flow</span>
            <span className="text-label break-all">{s.pipeline || s.flow || "-"}</span>
            <span className="text-label-tertiary font-medium">Stage</span>
            <span className="text-label break-all">{s.stage || "-"}</span>
            <span className="text-label-tertiary font-medium">Repo</span>
            <span className="text-label break-all">{s.repo || "-"}</span>
            <span className="text-label-tertiary font-medium">Branch</span>
            <span className="text-label break-all">{s.branch || "-"}</span>
            <span className="text-label-tertiary font-medium">Group</span>
            <span className="text-label break-all">{s.group_name || "-"}</span>
            <span className="text-label-tertiary font-medium">Created</span>
            <span className="text-label break-all">{relTime(s.created_at)}</span>
            <span className="text-label-tertiary font-medium">Updated</span>
            <span className="text-label break-all">{relTime(s.updated_at)}</span>
          </div>
        </div>

        {/* Flow Pipeline */}
        {flowStages.length > 1 && s.stage && (
          <div className="mb-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Flow Pipeline</div>
            <div className="flex gap-0 flex-wrap items-center text-xs">
              {flowStages.map((st: any, i: number) => {
                const isCurrent = st.name === s.stage;
                const currentIdx = flowStages.findIndex((x: any) => x.name === s.stage);
                const isPast = currentIdx > i;
                return (
                  <span key={st.name} className="inline-flex items-center">
                    {i > 0 && <span className="text-label-quaternary mx-1">&gt;</span>}
                    <span className={cn(
                      "font-mono text-[11px]",
                      isCurrent && "text-tint font-bold",
                      isPast && "text-success",
                      !isCurrent && !isPast && "text-label-quaternary"
                    )}>
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
          <div className="mb-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Completion Summary</div>
            <div className="text-xs text-label-secondary leading-relaxed">{s.config.completion_summary}</div>
          </div>
        )}

        {/* Token Usage & Cost */}
        {s.config?.usage && (
          <div className="mb-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Usage</div>
            <div className="grid grid-cols-[100px_1fr] gap-x-3.5 gap-y-1.5 text-xs">
              {s.config.usage.input_tokens != null && (
                <>
                  <span className="text-label-tertiary font-medium">Input tokens</span>
                  <span className="text-label font-mono">{humanTokens(s.config.usage.input_tokens)}</span>
                </>
              )}
              {s.config.usage.output_tokens != null && (
                <>
                  <span className="text-label-tertiary font-medium">Output tokens</span>
                  <span className="text-label font-mono">{humanTokens(s.config.usage.output_tokens)}</span>
                </>
              )}
              {s.config.usage.cache_read_input_tokens != null && (
                <>
                  <span className="text-label-tertiary font-medium">Cache read</span>
                  <span className="text-label font-mono">{humanTokens(s.config.usage.cache_read_input_tokens)}</span>
                </>
              )}
              {s.config.usage.total_tokens != null && (
                <>
                  <span className="text-label-tertiary font-medium">Total tokens</span>
                  <span className="text-label font-mono">{humanTokens(s.config.usage.total_tokens)}</span>
                </>
              )}
              {s.config.usage.total_cost != null && s.config.usage.total_cost > 0 && (
                <>
                  <span className="text-label-tertiary font-medium">Cost</span>
                  <span className="text-warning font-mono">{formatCost(s.config.usage.total_cost)}</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Preview Changes / Create PR */}
        {s.workdir && s.status !== "deleting" && (
          <div className="mb-5">
            <div className="flex gap-1.5 flex-wrap">
              <button className={cn(btnBase, btnSm)} onClick={handlePreviewDiff}>Preview Changes</button>
              {!readOnly && (
                <button className={cn(btnBase, btnSm)} onClick={() => { setPrTitle(s.summary || ""); setShowPRForm(!showPRForm); }}>Create PR</button>
              )}
            </div>
            {prUrl && (
              <div className="mt-1.5 text-xs">
                PR: <a href={prUrl} target="_blank" rel="noopener noreferrer" className="text-info hover:underline">{prUrl}</a>
              </div>
            )}
            {s.pr_url && !prUrl && (
              <div className="mt-1.5 text-xs">
                PR: <a href={s.pr_url} target="_blank" rel="noopener noreferrer" className="text-info hover:underline">{s.pr_url}</a>
              </div>
            )}
            {showPRForm && (
              <div className="mt-2 flex flex-col gap-1.5">
                <input
                  className={cn(inputBase, inputSm)}
                  placeholder="PR title"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                />
                <label className="text-[11px] flex items-center gap-1 text-label-secondary">
                  <input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} />
                  Draft PR
                </label>
                <div className="flex gap-1.5 flex-wrap">
                  <button className={cn(btnBase, btnSm, btnPrimary)} onClick={handleCreatePR}>Submit PR</button>
                  <button className={cn(btnBase, btnSm)} onClick={() => setShowPRForm(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Diff Preview */}
        {showDiff && diffData && (
          <div className="mb-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8 flex items-center gap-2">
              Changes: {diffData.branch} vs {diffData.baseBranch}
              <button className={cn(btnBase, btnSm, "ml-2")} onClick={() => setShowDiff(false)}>Close</button>
            </div>
            <div className="text-[11px] text-label-tertiary mb-1.5 font-mono">
              {diffData.filesChanged} files changed, +{diffData.insertions} -{diffData.deletions}
            </div>
            {diffData.modifiedSinceReview?.length > 0 && (
              <div className="text-warning text-[11px] mb-1.5">
                Modified since last review: {diffData.modifiedSinceReview.join(", ")}
              </div>
            )}
            <pre className="bg-[rgba(8,8,12,0.8)] border border-white/8 rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[400px] overflow-auto whitespace-pre-wrap break-all text-label-secondary shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)]">
              {diffData.stat || diffData.message || "No changes"}
            </pre>
          </div>
        )}

        {/* Todos */}
        <div className="mb-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8 flex items-center gap-2">
            Todos
            {!readOnly && (
              <button className={cn(btnBase, btnSm, "ml-2")} onClick={handleRunVerification}>Run Verification</button>
            )}
          </div>
          {todos.length === 0 && <div className="text-xs text-label-tertiary">No todos</div>}
          {todos.map((t: any) => (
            <div key={t.id} className="flex items-center gap-1.5 mb-1">
              {!readOnly && (
                <input
                  type="checkbox"
                  checked={t.done}
                  onChange={() => handleToggleTodo(t.id)}
                />
              )}
              <span className={cn("flex-1 text-xs", t.done ? "line-through text-label-tertiary" : "text-label")}>
                {t.content}
              </span>
              {!readOnly && (
                <button className={cn(btnBase, "px-1 py-0 text-[10px]", btnDanger)} onClick={() => handleDeleteTodo(t.id)}>x</button>
              )}
            </div>
          ))}
          {!readOnly && (
            <div className="flex gap-1 mt-1.5">
              <input
                className={cn(inputBase, inputSm, "flex-1")}
                placeholder="Add a todo..."
                value={newTodo}
                onChange={(e) => setNewTodo(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAddTodo(); }}
              />
              <button className={cn(btnBase, btnSm)} disabled={!newTodo.trim()} onClick={handleAddTodo}>Add</button>
            </div>
          )}
        </div>

        {/* Verification Result */}
        {verifyResult && (
          <div className="mb-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">
              Verification: {verifyResult.ok ? <span className="text-success">PASSED</span> : <span className="text-danger">FAILED</span>}
            </div>
            {!verifyResult.todosResolved && (
              <div className="text-xs text-danger mb-1">
                Pending todos: {verifyResult.pendingTodos?.join(", ")}
              </div>
            )}
            {verifyResult.scriptResults?.map((r: any, i: number) => (
              <div key={i} className="text-xs mb-1">
                <span className={cn("font-mono text-[10px]", r.passed ? "text-success" : "text-danger")}>{r.passed ? "[PASS]" : "[FAIL]"}</span>{" "}
                <code className="font-mono text-[11px]">{r.script}</code>
                {!r.passed && r.output && (
                  <pre className="text-[10px] text-label-tertiary mt-0.5 whitespace-pre-wrap font-mono">{r.output.slice(0, 500)}</pre>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Files Changed */}
        {s.config?.filesChanged?.length > 0 && (
          <div className="mb-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Files Changed ({s.config.filesChanged.length})</div>
            <div className="max-h-[200px] overflow-y-auto">
              {s.config.filesChanged.map((f: string) => (
                <div key={f} className="text-[11px] text-label-secondary py-px font-mono">{f}</div>
              ))}
            </div>
          </div>
        )}

        {/* Commits */}
        {s.config?.commits?.length > 0 && (
          <div className="mb-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Commits ({s.config.commits.length})</div>
            {s.config.commits.map((c: string) => {
              const shortSha = c.slice(0, 7);
              const ghBase = s.config?.github_url;
              const commitUrl = ghBase ? `${ghBase}/commit/${c}` : null;
              return (
                <div key={c} className="text-[11px] text-label-secondary font-mono py-px">
                  {commitUrl ? (
                    <a href={commitUrl} target="_blank" rel="noopener noreferrer" className="text-info hover:underline">{shortSha}</a>
                  ) : shortSha}
                </div>
              );
            })}
          </div>
        )}

        {/* Channel Port */}
        {(s.status === "running" || s.status === "waiting") && s.session_id && (
          <div className="mb-5">
            <div className="text-[11px] text-success font-mono">
              Channel: port {channelPort}
            </div>
          </div>
        )}

        {/* Output */}
        {output && (
          <div className="mb-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Live Output</div>
            <div ref={outputRef} className="bg-[rgba(8,8,12,0.8)] border border-white/8 rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-label-secondary shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)]">{output}</div>
          </div>
        )}

        {/* Events */}
        {events.length > 0 && (
          <div className="mb-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Events ({events.length})</div>
            <div className="flex flex-col gap-0 relative">
              {events.slice(-50).reverse().map((ev: any, i: number) => (
                <div key={i} className="flex gap-3 py-1.5 text-[11px] border-l border-white/8 ml-1 pl-3.5 relative rounded-r-lg hover:bg-white/3 transition-colors duration-200 before:content-[''] before:absolute before:left-[-3px] before:top-[10px] before:w-[5px] before:h-[5px] before:rounded-full before:bg-label-quaternary before:z-[1] first:before:bg-tint">
                  <span className="text-label-quaternary whitespace-nowrap shrink-0 w-[60px] font-mono text-[10px]">{relTime(ev.created_at)}</span>
                  <span className="text-label-secondary text-[11px]">
                    <b className="text-label font-medium">{ev.type}</b>
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
