import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi.js";
import { CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";

interface CodebaseMemoryStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  tools?: string[];
}

/**
 * Surface codebase-memory-mcp status for operators.
 *
 * This is the vendored DeusData/codebase-memory-mcp binary. When available,
 * it is injected into every session's .mcp.json at dispatch so agents
 * (Claude Code / Goose / Codex / Gemini) can call its 14 code-intelligence
 * tools directly. See docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md.
 */
export function CodebaseMemoryPanel() {
  const api = useApi();
  const [status, setStatus] = useState<CodebaseMemoryStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    api
      .codebaseMemoryStatus()
      .then((s) => {
        if (mounted) {
          setStatus(s);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [api]);

  if (loading) {
    return (
      <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">
        Checking codebase-memory-mcp status...
      </div>
    );
  }

  if (!status) {
    return (
      <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">
        Unable to read codebase-memory-mcp status.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {status.available ? (
            <CheckCircle2 size={16} className="text-[var(--completed)]" />
          ) : (
            <AlertCircle size={16} className="text-[var(--waiting)]" />
          )}
          <h3 className="text-sm font-semibold">codebase-memory-mcp</h3>
        </div>
        <a
          href="https://github.com/DeusData/codebase-memory-mcp"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          upstream <ExternalLink size={10} />
        </a>
      </div>

      {status.available ? (
        <>
          <div className="text-xs text-muted-foreground space-y-1">
            <div>
              <span className="font-medium text-foreground">Version:</span> {status.version ?? "unknown"}
            </div>
            <div className="truncate">
              <span className="font-medium text-foreground">Binary:</span> <code>{status.path}</code>
            </div>
            <div>
              <span className="font-medium text-foreground">Exposure:</span> injected into every session's{" "}
              <code>.mcp.json</code> as <code>codebase-memory</code>. Agents see 14 tools as{" "}
              <code>mcp__codebase-memory__*</code>.
            </div>
          </div>

          {status.tools && status.tools.length > 0 && (
            <div>
              <div className="text-xs font-medium mb-1 text-foreground">
                Tools available to agents ({status.tools.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {status.tools.map((t) => (
                  <span
                    key={t}
                    className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground font-mono"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="text-xs text-muted-foreground space-y-1">
          <div>Binary not found. Vendor with:</div>
          <pre className="bg-secondary p-2 rounded text-[11px] font-mono">make vendor-codebase-memory-mcp</pre>
          <div>Or install globally from upstream releases (v0.6.0+).</div>
        </div>
      )}
    </div>
  );
}
