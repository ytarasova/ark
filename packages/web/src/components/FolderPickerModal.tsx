import { useEffect, useState, useCallback, type KeyboardEvent } from "react";
import { api } from "../hooks/useApi.js";
import { Modal } from "./ui/modal.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

interface DirEntry {
  name: string;
  path: string;
  isGitRepo?: boolean;
}

interface FolderPickerModalProps {
  initialPath?: string;
  onSelect: (absPath: string) => void;
  onClose: () => void;
}

const LAST_REPO_KEY = "ark:lastPickedRepo";

/**
 * Server-backed folder picker. Lists directories via `fs/list-dir` and lets
 * the user navigate and pick one. Only reachable from local mode -- the
 * backend refuses the RPC when running hosted.
 */
export function FolderPickerModal({ initialPath, onSelect, onClose }: FolderPickerModalProps) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  // Priority: explicit initialPath > last picked (localStorage) > server default (home).
  const [requestedPath, setRequestedPath] = useState<string | undefined>(() => {
    if (initialPath && initialPath !== ".") return initialPath;
    try {
      return localStorage.getItem(LAST_REPO_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  });

  const load = useCallback((path: string | undefined) => {
    setLoading(true);
    setError(null);
    api
      .listDir(path)
      .then((res) => {
        setCwd(res.cwd);
        setParent(res.parent);
        setEntries(res.entries);
        setPathInput(res.cwd);
      })
      .catch((err: Error) => {
        setError(err.message || "Failed to list directory");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(requestedPath);
  }, [requestedPath, load]);

  function enterDir(path: string) {
    setRequestedPath(path);
  }

  function goUp() {
    if (parent) setRequestedPath(parent);
  }

  function submitSelection() {
    if (!cwd) return;
    try { localStorage.setItem(LAST_REPO_KEY, cwd); } catch { /* ignore */ }
    onSelect(cwd);
  }

  function handlePathKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = pathInput.trim();
      if (trimmed) setRequestedPath(trimmed);
    }
  }

  return (
    <Modal open onClose={onClose} title="Select repository folder">
      <div className="flex min-h-0 flex-1 flex-col p-4 gap-3">
        <div className="flex items-center gap-2">
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={handlePathKeyDown}
            placeholder="/absolute/path"
            spellCheck={false}
            autoCapitalize="off"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const trimmed = pathInput.trim();
              if (trimmed) setRequestedPath(trimmed);
            }}
            disabled={loading}
          >
            Go
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
          {loading && (
            <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>
          )}
          {error && (
            <div className="px-3 py-2 text-sm text-destructive">{error}</div>
          )}
          {!loading && !error && (
            <ul className="divide-y divide-border">
              {parent && (
                <li>
                  <button
                    type="button"
                    onClick={goUp}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
                  >
                    <span aria-hidden>↑</span>
                    <span>..</span>
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {parent}
                    </span>
                  </button>
                </li>
              )}
              {entries.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted-foreground">
                  (no sub-directories)
                </li>
              )}
              {entries.map((ent) => (
                <li key={ent.path}>
                  <button
                    type="button"
                    onDoubleClick={() => enterDir(ent.path)}
                    onClick={() => enterDir(ent.path)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
                  >
                    <span aria-hidden>📁</span>
                    <span className="truncate">{ent.name}</span>
                    {ent.isGitRepo && (
                      <span className="ml-2 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                        git
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="truncate text-xs text-muted-foreground">
            {cwd ? `Current: ${cwd}` : ""}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={submitSelection}
              disabled={!cwd || loading}
            >
              Select this folder
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
