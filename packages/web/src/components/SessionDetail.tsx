import { useState, useEffect, useRef } from "react";
import { StatusBadge } from "./StatusDot.js";
import { api } from "../hooks/useApi.js";
import { relTime, fmtCost } from "../util.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Separator } from "./ui/separator.js";
import { Badge } from "./ui/badge.js";
import { X } from "lucide-react";

/** Format a token count for display (e.g. 1500 -> "1.5k"). */
function humanTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

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
      <div className="flex gap-1.5 flex-wrap">
        {(s === "ready" || s === "pending") && (
          <Button size="xs" onClick={() => onAction("dispatch")}>Dispatch</Button>
        )}
        {(s === "running" || s === "waiting") && (
          <Button variant="warning" size="xs" onClick={() => onAction("stop")}>Stop</Button>
        )}
        {(s === "running" || s === "waiting") && (
          <Button variant="outline" size="xs" onClick={() => onAction("pause")}>Pause</Button>
        )}
        {(s === "running" || s === "waiting") && (
          <Button variant="outline" size="xs" onClick={() => onAction("interrupt")}>Interrupt</Button>
        )}
        {(s === "running" || s === "waiting" || s === "blocked") && (
          <Button size="xs" onClick={() => onAction("advance")}>Advance</Button>
        )}
        {(s === "running" || s === "waiting" || s === "blocked") && (
          <Button variant="success" size="xs" onClick={() => onAction("complete")}>Complete</Button>
        )}
        {(s === "stopped" || s === "failed") && (
          <Button variant="success" size="xs" onClick={() => onAction("restart")}>Restart</Button>
        )}
        {s !== "deleting" && (
          <Button variant="outline" size="xs" onClick={() => onAction("fork")}>Fork</Button>
        )}
        {(s === "running" || s === "waiting") && (
          <Button variant="outline" size="xs" onClick={() => setShowSend(!showSend)}>Send</Button>
        )}
        {(s === "completed" || s === "stopped" || s === "failed") && (
          <Button variant="outline" size="xs" onClick={() => onAction("archive")}>Archive</Button>
        )}
        {s === "archived" && (
          <Button variant="outline" size="xs" onClick={() => onAction("restore")}>Restore</Button>
        )}
        {s !== "deleting" && (
          <Button variant="destructive" size="xs" onClick={() => onAction("delete")}>Delete</Button>
        )}
        {s === "deleting" && (
          <Button variant="outline" size="xs" onClick={() => onAction("undelete")}>Undelete</Button>
        )}
      </div>
      {showSend && (
        <div className="flex gap-1 mt-1.5">
          <Input
            className="flex-1 h-7 text-xs"
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
          <Button
            size="xs"
            disabled={!sendMsg.trim()}
            onClick={() => {
              if (sendMsg.trim()) {
                onSend(sendMsg.trim());
                setSendMsg("");
                setShowSend(false);
              }
            }}
          >Send</Button>
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
  const [messages, setMessages] = useState<any[]>([]);
  const [cost, setCost] = useState<{
    cost: number; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; total_tokens: number;
  } | null>(null);

  // Load todos
  useEffect(() => {
    if (!sessionId) return;
    api.getTodos(sessionId).then((data) => setTodos(Array.isArray(data) ? data : [])).catch(() => {});
  }, [sessionId]);

  // Load conversation messages
  useEffect(() => {
    if (!sessionId) return;
    api.getMessages(sessionId)
      .then((data) => setMessages(Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [sessionId]);

  // Load detail
  useEffect(() => {
    if (!sessionId) return;
    api.getSession(sessionId).then(setDetail);
  }, [sessionId]);

  // Load session cost from usage_records
  useEffect(() => {
    if (!sessionId) { setCost(null); return; }
    api.getSessionCost(sessionId).then(setCost).catch(() => setCost(null));
  }, [sessionId, detail?.session?.updated_at]);

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
    try {
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
    } catch (err: any) {
      onToast(err.message || "Action failed", "error");
    }
  }

  async function handlePreviewDiff() {
    try {
      const data = await api.worktreeDiff(sessionId);
      setDiffData(data);
      setShowDiff(true);
    } catch (err: any) {
      onToast(err.message || "Failed to load diff", "error");
    }
  }

  async function handleCreatePR() {
    try {
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
    } catch (err: any) {
      onToast(err.message || "PR creation failed", "error");
    }
  }

  async function handleAddTodo() {
    try {
      if (!newTodo.trim()) return;
      const res = await api.addTodo(sessionId, newTodo.trim());
      if (res.ok !== false && res.todo) {
        setTodos([...todos, res.todo]);
        setNewTodo("");
      } else {
        onToast("Failed to add todo", "error");
      }
    } catch (err: any) {
      onToast(err.message || "Failed to add todo", "error");
    }
  }

  async function handleToggleTodo(id: number) {
    try {
      const res = await api.toggleTodo(id);
      if (res.ok !== false && res.todo) {
        setTodos(todos.map(t => t.id === id ? res.todo : t));
      }
    } catch (err: any) {
      onToast(err.message || "Failed to toggle todo", "error");
    }
  }

  async function handleDeleteTodo(id: number) {
    try {
      const res = await api.deleteTodo(id);
      if (res.ok !== false) {
        setTodos(todos.filter(t => t.id !== id));
      }
    } catch (err: any) {
      onToast(err.message || "Failed to delete todo", "error");
    }
  }

  async function handleRunVerification() {
    try {
      const result = await api.runVerification(sessionId);
      setVerifyResult(result);
      if (result.ok) {
        onToast("Verification passed", "success");
      } else {
        onToast("Verification failed", "error");
      }
    } catch (err: any) {
      onToast(err.message || "Verification failed", "error");
    }
  }

  async function handleSend(message: string) {
    try {
      const res = await api.send(sessionId, message);
      if (res.ok !== false) {
        onToast("Message sent", "success");
      } else {
        onToast(res.message || "Send failed", "error");
      }
    } catch (err: any) {
      onToast(err.message || "Send failed", "error");
    }
  }

  if (!detail || !detail.session) {
    return (
      <div className="flex flex-col h-full bg-background">
        <div className="h-[52px] px-5 border-b border-border flex justify-between items-center shrink-0">
          <span className="text-xs text-muted-foreground">Loading...</span>
          <Button variant="ghost" size="icon-xs" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>
      </div>
    );
  }

  const s = detail.session;
  const events = detail.events || [];

  // Channel port: deterministic from session ID
  const channelPort = 19200 + (parseInt(s.id.replace("s-", ""), 16) % 10000);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="h-[52px] px-5 border-b border-border flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <StatusBadge status={s.status} />
          <span className="font-semibold text-[13px] text-foreground">{s.id}</span>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X size={14} />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">
        {/* Actions */}
        {!readOnly && (
          <div className="mb-5">
            <SessionActions session={s} onAction={handleAction} onSend={handleSend} />
          </div>
        )}

        {/* Metadata */}
        <div className="mb-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Details</h3>
          <Separator className="mb-2" />
          <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            <span className="text-muted-foreground">Summary</span>
            <span className="text-card-foreground break-all">{s.summary || "-"}</span>
            <span className="text-muted-foreground">Agent</span>
            <span className="text-card-foreground break-all">{s.agent || "-"}</span>
            <span className="text-muted-foreground">Flow</span>
            <span className="text-card-foreground break-all">{s.pipeline || s.flow || "-"}</span>
            <span className="text-muted-foreground">Stage</span>
            <span className="text-card-foreground break-all">{s.stage || "-"}</span>
            <span className="text-muted-foreground">Repo</span>
            <span className="text-card-foreground break-all">{s.repo || "-"}</span>
            <span className="text-muted-foreground">Branch</span>
            <span className="text-card-foreground break-all">{s.branch || "-"}</span>
            <span className="text-muted-foreground">Group</span>
            <span className="text-card-foreground break-all">{s.group_name || "-"}</span>
            <span className="text-muted-foreground">Created</span>
            <span className="text-card-foreground break-all">{relTime(s.created_at)}</span>
            <span className="text-muted-foreground">Updated</span>
            <span className="text-card-foreground break-all">{relTime(s.updated_at)}</span>
          </div>
        </div>

        {/* Flow Pipeline */}
        {flowStages.length > 1 && s.stage && (
          <div className="mb-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Flow Pipeline</h3>
            <Separator className="mb-2" />
            <div className="flex gap-0 flex-wrap items-center text-xs">
              {flowStages.map((st: any, i: number) => {
                const isCurrent = st.name === s.stage;
                const currentIdx = flowStages.findIndex((x: any) => x.name === s.stage);
                const isPast = currentIdx > i;
                return (
                  <span key={st.name} className="inline-flex items-center">
                    {i > 0 && <span className="text-muted-foreground mx-1">&gt;</span>}
                    <span className={cn(
                      "font-mono text-[11px]",
                      isCurrent && "text-primary font-bold",
                      isPast && "text-emerald-400",
                      !isCurrent && !isPast && "text-muted-foreground"
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
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Completion Summary</h3>
            <Separator className="mb-2" />
            <div className="text-xs text-muted-foreground leading-relaxed">{s.config.completion_summary}</div>
          </div>
        )}

        {/* Token Usage & Cost */}
        {cost && cost.total_tokens > 0 && (
          <div className="mb-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Usage</h3>
            <Separator className="mb-2" />
            <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
              <span className="text-muted-foreground">Input tokens</span>
              <span className="text-card-foreground font-mono">{humanTokens(cost.input_tokens)}</span>
              <span className="text-muted-foreground">Output tokens</span>
              <span className="text-card-foreground font-mono">{humanTokens(cost.output_tokens)}</span>
              {cost.cache_read_tokens > 0 && (
                <>
                  <span className="text-muted-foreground">Cache read</span>
                  <span className="text-card-foreground font-mono">{humanTokens(cost.cache_read_tokens)}</span>
                </>
              )}
              <span className="text-muted-foreground">Total tokens</span>
              <span className="text-card-foreground font-mono">{humanTokens(cost.total_tokens)}</span>
              {cost.cost > 0 && (
                <>
                  <span className="text-muted-foreground">Cost</span>
                  <span className="text-amber-400 font-mono">{fmtCost(cost.cost)}</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Preview Changes / Create PR */}
        {s.workdir && s.status !== "deleting" && (
          <div className="mb-5">
            <div className="flex gap-1.5 flex-wrap">
              <Button variant="outline" size="xs" onClick={handlePreviewDiff}>Preview Changes</Button>
              {!readOnly && (
                <Button variant="outline" size="xs" onClick={() => { setPrTitle(s.summary || ""); setShowPRForm(!showPRForm); }}>Create PR</Button>
              )}
            </div>
            {prUrl && (
              <div className="mt-1.5 text-xs">
                PR: <a href={prUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{prUrl}</a>
              </div>
            )}
            {s.pr_url && !prUrl && (
              <div className="mt-1.5 text-xs">
                PR: <a href={s.pr_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{s.pr_url}</a>
              </div>
            )}
            {showPRForm && (
              <div className="mt-2 flex flex-col gap-1.5">
                <Input
                  className="h-7 text-xs"
                  placeholder="PR title"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                />
                <label className="text-[11px] flex items-center gap-1 text-muted-foreground">
                  <input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} />
                  Draft PR
                </label>
                <div className="flex gap-1.5 flex-wrap">
                  <Button size="xs" onClick={handleCreatePR}>Submit PR</Button>
                  <Button variant="outline" size="xs" onClick={() => setShowPRForm(false)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Diff Preview */}
        {showDiff && diffData && (
          <div className="mb-5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2 flex items-center gap-2">
              Changes: {diffData.branch} vs {diffData.baseBranch}
              <Button variant="outline" size="xs" className="ml-2" onClick={() => setShowDiff(false)}>Close</Button>
            </div>
            <Separator className="mb-2" />
            <div className="text-[11px] text-muted-foreground mb-1.5 font-mono">
              {diffData.filesChanged} files changed, +{diffData.insertions} -{diffData.deletions}
            </div>
            {diffData.modifiedSinceReview?.length > 0 && (
              <div className="text-amber-400 text-[11px] mb-1.5">
                Modified since last review: {diffData.modifiedSinceReview.join(", ")}
              </div>
            )}
            <pre className="bg-black/40 border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
              {diffData.stat || diffData.message || "No changes"}
            </pre>
          </div>
        )}

        {/* Todos */}
        <div className="mb-5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2 flex items-center gap-2">
            Todos
            {!readOnly && (
              <Button variant="outline" size="xs" className="ml-2" onClick={handleRunVerification}>Run Verification</Button>
            )}
          </div>
          <Separator className="mb-2" />
          {todos.length === 0 && <div className="text-xs text-muted-foreground">No todos</div>}
          {todos.map((t: any) => (
            <div key={t.id} className="flex items-center gap-1.5 mb-1">
              {!readOnly && (
                <input
                  type="checkbox"
                  checked={t.done}
                  onChange={() => handleToggleTodo(t.id)}
                />
              )}
              <span className={cn("flex-1 text-xs", t.done ? "line-through text-muted-foreground" : "text-foreground")}>
                {t.content}
              </span>
              {!readOnly && (
                <Button variant="destructive" size="xs" className="h-5 px-1 text-[10px]" onClick={() => handleDeleteTodo(t.id)}>x</Button>
              )}
            </div>
          ))}
          {!readOnly && (
            <div className="flex gap-1 mt-1.5">
              <Input
                className="flex-1 h-7 text-xs"
                placeholder="Add a todo..."
                value={newTodo}
                onChange={(e) => setNewTodo(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAddTodo(); }}
              />
              <Button variant="outline" size="xs" disabled={!newTodo.trim()} onClick={handleAddTodo}>Add</Button>
            </div>
          )}
        </div>

        {/* Verification Result */}
        {verifyResult && (
          <div className="mb-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
              Verification: {verifyResult.ok ? <Badge variant="success">PASSED</Badge> : <Badge variant="destructive">FAILED</Badge>}
            </h3>
            <Separator className="mb-2" />
            {!verifyResult.todosResolved && (
              <div className="text-xs text-red-400 mb-1">
                Pending todos: {verifyResult.pendingTodos?.join(", ")}
              </div>
            )}
            {verifyResult.scriptResults?.map((r: any, i: number) => (
              <div key={i} className="text-xs mb-1">
                <Badge variant={r.passed ? "success" : "destructive"} className="text-[10px]">{r.passed ? "PASS" : "FAIL"}</Badge>{" "}
                <code className="font-mono text-[11px] text-muted-foreground">{r.script}</code>
                {!r.passed && r.output && (
                  <pre className="text-[10px] text-muted-foreground mt-0.5 whitespace-pre-wrap font-mono">{r.output.slice(0, 500)}</pre>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Files Changed */}
        {s.config?.filesChanged?.length > 0 && (
          <div className="mb-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Files Changed ({s.config.filesChanged.length})</h3>
            <Separator className="mb-2" />
            <div className="overflow-y-auto">
              {s.config.filesChanged.map((f: string) => (
                <div key={f} className="text-[11px] text-muted-foreground py-px font-mono">{f}</div>
              ))}
            </div>
          </div>
        )}

        {/* Commits */}
        {s.config?.commits?.length > 0 && (
          <div className="mb-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Commits ({s.config.commits.length})</h3>
            <Separator className="mb-2" />
            {s.config.commits.map((c: string) => {
              const shortSha = c.slice(0, 7);
              const ghBase = s.config?.github_url;
              const commitUrl = ghBase ? `${ghBase}/commit/${c}` : null;
              return (
                <div key={c} className="text-[11px] text-muted-foreground font-mono py-px">
                  {commitUrl ? (
                    <a href={commitUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{shortSha}</a>
                  ) : shortSha}
                </div>
              );
            })}
          </div>
        )}

        {/* Channel Port */}
        {(s.status === "running" || s.status === "waiting") && s.session_id && (
          <div className="mb-5">
            <div className="text-[11px] text-emerald-400 font-mono">
              Channel: port {channelPort}
            </div>
          </div>
        )}

        {/* Conversation */}
        {messages.length > 0 && (
          <div className="mb-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Conversation ({messages.length})</h3>
            <Separator className="mb-2" />
            <div className="flex flex-col gap-1.5 overflow-y-auto">
              {messages.map((m: any, i: number) => (
                <div
                  key={m.id || i}
                  className={cn(
                    "rounded-lg px-3 py-2 text-[12px] leading-relaxed max-w-[85%]",
                    m.role === "user"
                      ? "bg-primary/10 border border-primary/20 self-end text-foreground"
                      : "bg-secondary border border-border self-start text-card-foreground"
                  )}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={cn("text-[10px] font-semibold uppercase", m.role === "user" ? "text-primary" : "text-muted-foreground")}>
                      {m.role}
                    </span>
                    {m.type && m.type !== "text" && (
                      <Badge variant="secondary" className="text-[9px] py-0 px-1">{m.type}</Badge>
                    )}
                    {m.created_at && (
                      <span className="text-[10px] text-muted-foreground">{relTime(m.created_at)}</span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Output */}
        {output && (
          <div className="mb-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Live Output</h3>
            <Separator className="mb-2" />
            <div ref={outputRef} className="bg-black/40 border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground">{output}</div>
          </div>
        )}

        {/* Events */}
        {events.length > 0 && (
          <div className="mb-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Events ({events.length})</h3>
            <Separator className="mb-2" />
            <div className="flex flex-col gap-0 relative">
              {events.slice(-50).reverse().map((ev: any, i: number) => (
                <div key={i} className="flex gap-3 py-1.5 text-[11px] border-l border-border ml-1 pl-3.5 relative rounded-r-lg hover:bg-accent transition-colors duration-200 before:content-[''] before:absolute before:left-[-3px] before:top-[10px] before:w-[5px] before:h-[5px] before:rounded-full before:bg-muted-foreground before:z-[1] first:before:bg-primary">
                  <span className="text-muted-foreground whitespace-nowrap shrink-0 w-[60px] font-mono text-[10px]">{relTime(ev.created_at)}</span>
                  <span className="text-muted-foreground text-[11px]">
                    <b className="text-foreground font-medium">{ev.type}</b>
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
