import { useCallback, useEffect, useState } from "react";
import { api } from "../../hooks/useApi.js";
import { cn } from "../../lib/utils.js";
import { relTime } from "../../util.js";

/** Loads and displays the last N conversation turns for a Claude session. */
export function TranscriptMessages({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [indexing, setIndexing] = useState(false);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getConversation(sessionId, 50);
      setTurns(Array.isArray(data) ? data : []);
    } catch {
      setTurns([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (sessionId) loadMessages();
  }, [sessionId, loadMessages]);

  const handleIndex = async () => {
    setIndexing(true);
    try {
      await api.refreshHistory();
      await loadMessages();
    } catch {
      // ignore
    } finally {
      setIndexing(false);
    }
  };

  if (loading) {
    return <div className="text-[11px] text-muted-foreground py-4">Loading messages...</div>;
  }
  if (turns.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground py-4">
        No indexed messages yet.{" "}
        <button
          className={cn("text-primary hover:underline", indexing && "opacity-50 pointer-events-none")}
          onClick={handleIndex}
          disabled={indexing}
          aria-label="Index transcripts"
        >
          {indexing ? "Indexing..." : "Index transcripts"}
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
        Recent Messages ({turns.length})
      </h3>
      <div className="flex flex-col gap-1.5">
        {turns.map((t: any, i: number) => (
          <div
            key={i}
            className={cn(
              "rounded-lg px-3 py-2 text-[12px] leading-relaxed max-w-[90%]",
              t.role === "user"
                ? "bg-primary/10 border border-primary/20 self-end text-foreground"
                : "bg-secondary border border-border self-start text-card-foreground",
            )}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className={cn(
                  "text-[10px] font-semibold uppercase",
                  t.role === "user" ? "text-primary" : "text-muted-foreground",
                )}
              >
                {t.role}
              </span>
              {t.timestamp && <span className="text-[10px] text-muted-foreground">{relTime(t.timestamp)}</span>}
            </div>
            <div className="whitespace-pre-wrap break-words">
              {(t.content || "").slice(0, 500)}
              {(t.content || "").length > 500 ? "..." : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
