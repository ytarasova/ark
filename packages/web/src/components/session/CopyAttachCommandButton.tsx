/**
 * CopyAttachCommandButton -- fetches the CLI attach command for a session
 * via `session/attach-command` and exposes a copy-to-clipboard button.
 *
 * When the session is not attachable (completed/failed/not-yet-dispatched)
 * the button renders the returned `reason` instead of the command string so
 * the UI never lies about a pane that doesn't exist.
 */

import { useEffect, useState, useCallback } from "react";
import { useApi } from "../../hooks/useApi.js";
import { Button } from "../ui/button.js";

interface CopyAttachCommandButtonProps {
  sessionId: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; command: string; displayHint: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string };

export function CopyAttachCommandButton({ sessionId }: CopyAttachCommandButtonProps) {
  const api = useApi();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    api
      .getAttachCommand(sessionId)
      .then((res) => {
        if (cancelled) return;
        if (!res.attachable) {
          setState({
            kind: "unavailable",
            reason: res.reason ?? "Session is not attachable.",
          });
          return;
        }
        setState({ kind: "ready", command: res.command, displayHint: res.displayHint });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to fetch attach command",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  const copy = useCallback(async () => {
    if (state.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(state.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (insecure origin, etc.). Fall back to prompt.
      window.prompt("Copy this command:", state.command);
    }
  }, [state]);

  if (state.kind === "loading") {
    return <div className="text-[11px] text-[var(--fg-faint)]">Loading attach command...</div>;
  }

  if (state.kind === "error") {
    return (
      <div className="text-[11px] text-[var(--failed)]" data-testid="attach-command-error">
        {state.message}
      </div>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <div
        className="rounded-md border border-border bg-secondary px-3 py-2 text-[11px] text-[var(--fg-faint)]"
        data-testid="attach-command-unavailable"
      >
        {state.reason}
      </div>
    );
  }

  return (
    <div
      className="rounded-md border border-border bg-secondary px-3 py-2 flex flex-col gap-1"
      data-testid="attach-command-panel"
    >
      <p className="text-[11px] text-[var(--fg-faint)]">
        {state.displayHint || "Run this in your terminal for a native shell experience."}
      </p>
      <div className="flex items-center justify-between gap-2">
        <code
          className="text-[12px] font-[family-name:var(--font-mono)] truncate text-[var(--fg)]"
          data-testid="attach-command-text"
        >
          {state.command}
        </code>
        <Button
          variant="outline"
          size="xs"
          onClick={copy}
          className="h-6 px-2 text-[10px]"
          data-testid="attach-command-copy"
        >
          {copied ? "Copied" : "Copy CLI command"}
        </Button>
      </div>
    </div>
  );
}
