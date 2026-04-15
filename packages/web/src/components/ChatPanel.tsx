import { useState, useEffect, useRef } from "react";
import { useMessages } from "../hooks/useMessages.js";
import { relTime } from "../util.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Badge } from "./ui/badge.js";
import { X } from "lucide-react";

interface ChatPanelProps {
  sessionId: string;
  session: any;
  onClose: () => void;
  onToast: (msg: string, type: string) => void;
}

export function ChatPanel({ sessionId, session, onClose, onToast }: ChatPanelProps) {
  const { messages, send, sending } = useMessages({ sessionId, enabled: true, pollMs: 2000 });
  const [msg, setMsg] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  // Auto-scroll to bottom on new messages (unless user scrolled up)
  useEffect(() => {
    if (!userScrolled && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, userScrolled]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setUserScrolled(!atBottom);
  }

  async function handleSend() {
    const text = msg.trim();
    if (!text) return;
    setMsg("");
    setUserScrolled(false);
    const res = await send(text);
    if (res.ok === false) {
      onToast(res.message || "Send failed", "error");
    }
  }

  const isActive = session.status === "running" || session.status === "waiting";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-10 border-b border-border px-4 flex items-center justify-between shrink-0">
        <span className="text-xs font-medium text-foreground truncate">Chat: {session.summary || session.id}</span>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X size={14} />
        </Button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5" onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
            No messages yet. Type below to send.
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              "rounded-lg px-3 py-2 text-[12px] leading-relaxed max-w-[85%]",
              m.role === "user"
                ? "bg-primary/10 border border-primary/20 self-end text-foreground"
                : "bg-secondary border border-border self-start text-card-foreground",
            )}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className={cn(
                  "text-[10px] font-semibold uppercase",
                  m.role === "user" ? "text-primary" : "text-muted-foreground",
                )}
              >
                {m.role}
              </span>
              {m.type && m.type !== "text" && (
                <Badge variant="secondary" className="text-[9px] py-0 px-1">
                  {m.type}
                </Badge>
              )}
              {m.created_at && <span className="text-[10px] text-muted-foreground">{relTime(m.created_at)}</span>}
            </div>
            <div className="whitespace-pre-wrap break-words">{m.content}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      {isActive && (
        <div className="border-t border-border p-2 flex gap-2 shrink-0">
          <Input
            className="flex-1 h-8 text-xs"
            placeholder="Message to agent..."
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && msg.trim() && !sending) {
                e.preventDefault();
                handleSend();
              }
            }}
            autoFocus
          />
          <Button size="xs" disabled={!msg.trim() || sending} onClick={handleSend}>
            {sending ? "..." : "Send"}
          </Button>
        </div>
      )}
    </div>
  );
}
