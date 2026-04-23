import { ToolBlockShell, FootStat, FootAction, FootSpacer } from "./shell.js";
import type { ToolStatus } from "./shell.js";
import { BashIcon, EditIcon, ReadIcon, WebFetchIcon, GrepIcon, WrenchIcon } from "./icons.js";
import { cn } from "../../../lib/utils.js";

export { ToolBlockShell, FootStat, FootAction, FootSpacer } from "./shell.js";
export type { ToolStatus, ToolBlockShellProps } from "./shell.js";

/* --------------------------------- Bash ---------------------------------- */

export interface BashToolBlockProps {
  command?: string;
  output?: string;
  status?: ToolStatus;
  elapsed?: string;
  pid?: string | number;
  cwd?: string;
}

export function BashToolBlock({ command, output, status = "ok", elapsed, pid, cwd }: BashToolBlockProps) {
  // Colorize basic ✓/✗ markers at the start of lines
  const lines = (output || "").split("\n").slice(-20);
  return (
    <ToolBlockShell
      icon={<BashIcon />}
      name="Bash"
      arg={
        command ? (
          <>
            <span className="text-[var(--fg-muted)]">$ </span>
            <span className="text-[#86efac]">{command}</span>
          </>
        ) : undefined
      }
      status={status}
      statusLabel={status === "running" ? "running" : status === "err" ? "failed" : "done"}
      elapsed={elapsed}
      bodyClassName="whitespace-pre"
      body={
        lines.length ? (
          <>
            {lines.map((ln, i) => {
              const trimmed = ln.trimStart();
              const isOk = trimmed.startsWith("✓") || trimmed.startsWith("PASS");
              const isErr = trimmed.startsWith("✗") || trimmed.startsWith("FAIL");
              return (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre",
                    isOk && "text-[#86efac]",
                    isErr && "text-[#fca5a5]",
                    !isOk && !isErr && "text-[var(--fg-muted)]",
                  )}
                >
                  {ln || " "}
                </div>
              );
            })}
          </>
        ) : (
          <span className="text-[var(--fg-faint)]">-- no output --</span>
        )
      }
      footer={
        <>
          {pid != null && <FootStat label="pid" value={pid} />}
          {cwd && <FootStat label="cwd" value={cwd} />}
          <FootSpacer />
          {status === "running" && <FootAction>stop ^C</FootAction>}
        </>
      }
    />
  );
}

/* --------------------------------- Edit ---------------------------------- */

export interface EditToolBlockProps {
  path?: string;
  plus?: number;
  minus?: number;
  hunk?: string;
  rows?: Array<{ kind?: "ctx" | "add" | "rm"; ln?: number | string; rn?: number | string; code: string }>;
  status?: ToolStatus;
  elapsed?: string;
  lineRange?: string;
  charPlus?: number;
  charMinus?: number;
  onViewFull?: () => void;
}

export function EditToolBlock({
  path,
  plus,
  minus,
  hunk,
  rows,
  status = "ok",
  elapsed,
  lineRange,
  charPlus,
  charMinus,
  onViewFull,
}: EditToolBlockProps) {
  return (
    <ToolBlockShell
      icon={<EditIcon />}
      name="Edit"
      arg={
        <>
          <span className="text-[var(--fg)]">{path}</span>
          {(plus != null || minus != null) && (
            <span className="text-[var(--fg-faint)] ml-[8px]">
              {plus != null && `+${plus}`} {minus != null && `-${minus}`}
            </span>
          )}
        </>
      }
      status={status}
      statusLabel={status === "running" ? "editing" : status === "err" ? "failed" : "ok"}
      elapsed={elapsed}
      plainBody
      body={
        <div className="bg-[var(--bg-code)] font-[family-name:var(--font-mono)] text-[12px] leading-[1.55]">
          {hunk && (
            <div className="px-[10px] py-[2px] bg-[rgba(107,89,222,0.07)] text-[var(--fg-muted)] text-[11px] border-y border-[var(--border)]">
              {hunk}
            </div>
          )}
          {rows?.slice(0, 12).map((r, i) => {
            const kind = r.kind ?? "ctx";
            return (
              <div
                key={i}
                className={cn(
                  "grid items-start",
                  kind === "add" && "bg-[rgba(52,211,153,0.08)]",
                  kind === "rm" && "bg-[rgba(248,113,113,0.08)]",
                )}
                style={{ gridTemplateColumns: "32px 32px 1fr" }}
              >
                <span
                  className={cn(
                    "text-right px-[7px] bg-[rgba(0,0,0,0.15)] border-r border-[var(--border)] select-none",
                    kind === "rm" ? "text-[#fca5a5]" : "text-[var(--fg-faint)]",
                  )}
                >
                  {r.ln ?? ""}
                </span>
                <span
                  className={cn(
                    "text-right px-[7px] bg-[rgba(0,0,0,0.15)] border-r border-[var(--border)] select-none",
                    kind === "add" ? "text-[#86efac]" : "text-[var(--fg-faint)]",
                  )}
                >
                  {r.rn ?? ""}
                </span>
                <span className="px-[10px] whitespace-pre overflow-hidden text-ellipsis">{r.code}</span>
              </div>
            );
          })}
        </div>
      }
      footer={
        <>
          {lineRange && <FootStat label="lines" value={lineRange} />}
          {(charPlus != null || charMinus != null) && (
            <FootStat label="char" value={`+${charPlus ?? 0} -${charMinus ?? 0}`} />
          )}
          <FootSpacer />
          {onViewFull && <FootAction onClick={onViewFull}>view full file</FootAction>}
        </>
      }
    />
  );
}

/* --------------------------------- Read ---------------------------------- */

export interface ReadToolBlockProps {
  path?: string;
  lines?: string;
  preview?: string;
  status?: ToolStatus;
  elapsed?: string;
  size?: string;
  onOpen?: () => void;
}

export function ReadToolBlock({ path, lines, preview, status = "ok", elapsed, size, onOpen }: ReadToolBlockProps) {
  const rows = (preview || "").split("\n").slice(0, 12);
  return (
    <ToolBlockShell
      icon={<ReadIcon />}
      name="Read"
      arg={
        <>
          <span className="text-[var(--fg)]">{path}</span>
          {lines && <span className="text-[var(--fg-faint)] ml-[8px]">{lines}</span>}
        </>
      }
      status={status}
      statusLabel="read"
      elapsed={elapsed}
      bodyClassName="whitespace-pre"
      body={
        rows.length ? (
          rows.map((ln, i) => (
            <div key={i} className="whitespace-pre">
              <span className="text-[var(--fg-faint)] select-none pr-[10px]">
                {(i + 1).toString().padStart(3, " ")}
              </span>
              <span className="text-[var(--fg)]">{ln || " "}</span>
            </div>
          ))
        ) : (
          <span className="text-[var(--fg-faint)]">-- no preview --</span>
        )
      }
      footer={
        <>
          {size && <FootStat label="size" value={size} />}
          <FootSpacer />
          {onOpen && <FootAction onClick={onOpen}>open in editor</FootAction>}
        </>
      }
    />
  );
}

/* ------------------------------- WebFetch -------------------------------- */

export interface WebFetchToolBlockProps {
  url?: string;
  statusCode?: number;
  statusText?: string;
  retry?: string;
  cache?: string;
  body?: string;
  status?: ToolStatus;
  elapsed?: string;
}

export function WebFetchToolBlock({
  url,
  statusCode,
  statusText,
  retry,
  cache,
  body,
  status,
  elapsed,
}: WebFetchToolBlockProps) {
  const derived: ToolStatus = status ?? (statusCode == null ? "running" : statusCode >= 400 ? "err" : "ok");
  const prot = url?.match(/^([a-z]+:\/\/)/i)?.[1] ?? "";
  const urlRest = url?.slice(prot.length) ?? "";
  return (
    <ToolBlockShell
      icon={<WebFetchIcon />}
      name="WebFetch"
      status={derived}
      statusLabel={statusCode != null ? String(statusCode) : derived}
      elapsed={elapsed}
      plainBody
      body={
        <div className="bg-[var(--bg-code)]">
          {url && (
            <div className="px-[11px] py-[8px] font-[family-name:var(--font-mono)] text-[12px] text-[var(--primary)] border-b border-[var(--border)] bg-[rgba(107,89,222,0.05)] truncate">
              <span className="text-[var(--fg-faint)]">{prot}</span>
              {urlRest}
            </div>
          )}
          <div
            className="px-[11px] py-[9px] grid font-[family-name:var(--font-mono-ui)] text-[11px]"
            style={{ gridTemplateColumns: "auto 1fr", columnGap: "12px", rowGap: "3px" }}
          >
            {statusCode != null && (
              <>
                <span className="text-[var(--fg-faint)] uppercase tracking-[0.04em]">status</span>
                <span
                  className={cn(
                    "font-[family-name:var(--font-mono)] tracking-normal normal-case",
                    statusCode >= 400 ? "text-[var(--failed)]" : "text-[var(--fg)]",
                  )}
                >
                  {statusCode} {statusText}
                </span>
              </>
            )}
            {retry && (
              <>
                <span className="text-[var(--fg-faint)] uppercase tracking-[0.04em]">retry</span>
                <span className="font-[family-name:var(--font-mono)] tracking-normal normal-case text-[var(--fg)]">
                  {retry}
                </span>
              </>
            )}
            {cache && (
              <>
                <span className="text-[var(--fg-faint)] uppercase tracking-[0.04em]">cache</span>
                <span className="font-[family-name:var(--font-mono)] tracking-normal normal-case text-[var(--fg)]">
                  {cache}
                </span>
              </>
            )}
            {body && (
              <>
                <span className="text-[var(--fg-faint)] uppercase tracking-[0.04em]">body</span>
                <span className="font-[family-name:var(--font-mono)] tracking-normal normal-case text-[var(--fg-muted)] truncate">
                  {body}
                </span>
              </>
            )}
          </div>
        </div>
      }
    />
  );
}

/* ------------------------------ Generic fallback ------------------------- */

export interface GenericToolBlockProps {
  name: string;
  arg?: string;
  output?: string;
  status?: ToolStatus;
  elapsed?: string;
}

export function GenericToolBlock({ name, arg, output, status = "ok", elapsed }: GenericToolBlockProps) {
  const icon = {
    Grep: <GrepIcon />,
    grep: <GrepIcon />,
    Glob: <GrepIcon />,
    Bash: <BashIcon />,
    Edit: <EditIcon />,
    Write: <EditIcon />,
    MultiEdit: <EditIcon />,
    Read: <ReadIcon />,
    WebFetch: <WebFetchIcon />,
  }[name] ?? <WrenchIcon />;
  return (
    <ToolBlockShell
      icon={icon}
      name={name}
      arg={arg ? <span className="text-[var(--fg-muted)]">{arg}</span> : undefined}
      status={status}
      elapsed={elapsed}
      body={
        output ? (
          <div className="whitespace-pre-wrap text-[var(--fg-muted)]">{output.slice(0, 600)}</div>
        ) : (
          <span className="text-[var(--fg-faint)]">-- no output --</span>
        )
      }
    />
  );
}

/* ------------------------------- Dispatch -------------------------------- */

export interface ToolBlockProps {
  name: string;
  input?: any;
  output?: any;
  status?: ToolStatus;
  elapsed?: string;
  durationMs?: number;
}

function fmtDuration(ms?: number): string | undefined {
  if (ms == null) return undefined;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

/** Routes tool by name to the right block. */
export function ToolBlock({ name, input, output, status, elapsed, durationMs }: ToolBlockProps) {
  const e = elapsed ?? fmtDuration(durationMs);
  if (name === "Bash" || name === "bash") {
    return (
      <BashToolBlock
        command={typeof input === "string" ? input : input?.command}
        output={typeof output === "string" ? output : output?.stdout || output?.output}
        status={status}
        elapsed={e}
        pid={output?.pid}
        cwd={input?.cwd}
      />
    );
  }
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "write_file") {
    const path = input?.file_path || input?.path || (typeof input === "string" ? input : undefined);
    return <EditToolBlock path={path} status={status} elapsed={e} />;
  }
  if (name === "Read" || name === "read_file") {
    const path = input?.file_path || input?.path || (typeof input === "string" ? input : undefined);
    const lines =
      input?.offset != null ? `lines ${input.offset}-${(input.offset ?? 0) + (input.limit ?? 80)}` : undefined;
    return (
      <ReadToolBlock
        path={path}
        lines={lines}
        preview={typeof output === "string" ? output : output?.content}
        status={status}
        elapsed={e}
      />
    );
  }
  if (name === "WebFetch" || name === "web_fetch") {
    const url = input?.url || (typeof input === "string" ? input : undefined);
    return (
      <WebFetchToolBlock
        url={url}
        statusCode={output?.status}
        statusText={output?.statusText}
        status={status}
        elapsed={e}
      />
    );
  }
  const arg =
    typeof input === "string"
      ? input
      : input?.pattern || input?.command || input?.path || input?.file_path || JSON.stringify(input ?? {}).slice(0, 80);
  return (
    <GenericToolBlock
      name={name}
      arg={arg}
      output={typeof output === "string" ? output : output ? JSON.stringify(output).slice(0, 600) : undefined}
      status={status}
      elapsed={e}
    />
  );
}
