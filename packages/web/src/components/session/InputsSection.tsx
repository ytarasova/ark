/**
 * Flow-aware session inputs editor.
 *
 * Renders two editors driven by the selected flow's declarative `inputs:`
 * contract:
 *   - Files: role -> BlobStore locator. Upload encodes bytes and stores them
 *     via `input/upload`; the returned `locator` is opaque. In local mode the
 *     user may also type an absolute path directly.
 *   - Params: k -> v. Declared params get labels + defaults + pattern hints;
 *     the user may add arbitrary extra k=v rows at dispatch time.
 *
 * The final shape is bubbled to the parent as:
 *   { files: Record<role, locator | path>, params: Record<k, v> }
 *
 * Empty maps are fine -- callers should treat `undefined` as "no inputs".
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../../hooks/useApi.js";
import { useHostedMode } from "../../hooks/useServerConfig.js";
import { Button } from "../ui/button.js";
import { cn } from "../../lib/utils.js";
import { Paperclip, Plus, X, Upload } from "lucide-react";

interface FlowFileInput {
  description?: string;
  required?: boolean;
  accept?: string;
}
interface FlowParamInput {
  description?: string;
  required?: boolean;
  default?: string;
  pattern?: string;
}
interface FlowInputsSchema {
  files?: Record<string, FlowFileInput>;
  params?: Record<string, FlowParamInput>;
}

export interface InputsValue {
  files: Record<string, string>;
  params: Record<string, string>;
}

interface Props {
  flowName: string;
  value: InputsValue;
  onChange: (next: InputsValue) => void;
  /** Parent should set true when a required declared input is missing, so the submit button can be disabled. */
  onValidityChange?: (valid: boolean) => void;
  /** role -> blob URL for image previews. When set, thumbnails render next to the role label. */
  previews?: Record<string, string>;
  /** Called after a local file is selected so the parent can register a preview URL. */
  onPreview?: (role: string, blob: Blob) => void;
  /** Called when a row is removed so the parent can revoke the preview URL. */
  onClearPreview?: (role: string) => void;
}

const fieldClass = cn(
  "flex h-9 w-full rounded-md border border-[var(--border)] bg-transparent",
  "px-3 py-1 text-[13px] text-[var(--fg)] transition-colors",
  "placeholder:text-[var(--fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]",
);

export function InputsSection({
  flowName,
  value,
  onChange,
  onValidityChange,
  previews,
  onPreview,
  onClearPreview,
}: Props) {
  const hosted = useHostedMode();
  const [schema, setSchema] = useState<FlowInputsSchema | null>(null);

  // Ad-hoc extras: roles/keys the user added that are not in the flow schema.
  // Kept separately so we can render their rows with remove buttons.
  const [extraFileRoles, setExtraFileRoles] = useState<string[]>([]);
  const [extraParamKeys, setExtraParamKeys] = useState<string[]>([]);

  // Inline "add" rows. `null` = button visible; string = input visible (possibly empty).
  const [pendingFileRole, setPendingFileRole] = useState<string | null>(null);
  const [pendingFilePath, setPendingFilePath] = useState<string>("");
  const [pendingParamKey, setPendingParamKey] = useState<string | null>(null);
  const [pendingParamValue, setPendingParamValue] = useState<string>("");

  useEffect(() => {
    if (!flowName) {
      setSchema(null);
      return;
    }
    let cancelled = false;
    api
      .getFlowDetail(flowName)
      .then((f: any) => {
        if (cancelled) return;
        setSchema((f?.inputs ?? null) as FlowInputsSchema | null);
      })
      .catch(() => {
        if (!cancelled) setSchema(null);
      });
    return () => {
      cancelled = true;
    };
  }, [flowName]);

  // Seed declared param defaults once schema arrives. Deliberately ignoring
  // `value` / `onChange` in the dep array -- we only want to re-seed when the
  // schema itself changes, otherwise any param edit would retrigger seeding.
  useEffect(() => {
    if (!schema?.params) return;
    const nextParams = { ...value.params };
    let changed = false;
    for (const [k, def] of Object.entries(schema.params)) {
      if (nextParams[k] === undefined && def?.default !== undefined) {
        nextParams[k] = def.default;
        changed = true;
      }
    }
    if (changed) onChange({ ...value, params: nextParams });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  const declaredFileRoles = Object.keys(schema?.files ?? {});
  const declaredParamKeys = Object.keys(schema?.params ?? {});

  const allFileRoles = useMemo(() => {
    // Any role in `value.files` (including ones added via paste-upload) deserves a row.
    const out: string[] = [...declaredFileRoles];
    const pushIfNew = (r: string) => {
      if (!out.includes(r)) out.push(r);
    };
    for (const r of extraFileRoles) pushIfNew(r);
    for (const r of Object.keys(value.files ?? {})) pushIfNew(r);
    return out;
  }, [declaredFileRoles, extraFileRoles, value.files]);
  const allParamKeys = useMemo(
    () => [...declaredParamKeys, ...extraParamKeys.filter((k) => !declaredParamKeys.includes(k))],
    [declaredParamKeys, extraParamKeys],
  );

  // Validate declared-required inputs.
  useEffect(() => {
    if (!schema) {
      onValidityChange?.(true);
      return;
    }
    const missingFile = Object.entries(schema.files ?? {}).some(([role, def]) => def?.required && !value.files[role]);
    const missingParam = Object.entries(schema.params ?? {}).some(([k, def]) => {
      if (!def?.required) return false;
      const v = value.params[k];
      if (v === undefined || v === "") return true;
      if (def.pattern && !new RegExp(def.pattern).test(v)) return true;
      return false;
    });
    onValidityChange?.(!missingFile && !missingParam);
  }, [schema, value, onValidityChange]);

  async function handleUpload(role: string, file: File) {
    // Stash the preview before the upload lands so the UI shows the thumbnail immediately.
    onPreview?.(role, file);
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    // Chunked base64 to avoid call-stack issues on large files.
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    }
    const content = btoa(bin);
    // `input/upload` returns an opaque `{ locator }` (base64url of
    // `{tenant}/{ns}/{id}/{filename}`); the BlobStore owns the bytes and
    // the locator is what callers feed to `input/read` / flow templating.
    const { locator } = await api.uploadInput({ name: file.name, role, content, contentEncoding: "base64" });
    onChange({ ...value, files: { ...value.files, [role]: locator } });
  }

  function setFilePath(role: string, path: string) {
    onChange({ ...value, files: { ...value.files, [role]: path } });
  }

  function setParam(key: string, v: string) {
    onChange({ ...value, params: { ...value.params, [key]: v } });
  }

  function removeFile(role: string) {
    const { [role]: _omit, ...rest } = value.files;
    onChange({ ...value, files: rest });
    setExtraFileRoles((prev) => prev.filter((r) => r !== role));
    onClearPreview?.(role);
  }

  function removeParam(key: string) {
    const { [key]: _omit, ...rest } = value.params;
    onChange({ ...value, params: rest });
    setExtraParamKeys((prev) => prev.filter((k) => k !== key));
  }

  function cancelFileEdit() {
    setPendingFileRole(null);
    setPendingFilePath("");
  }

  /** Derive a default role from a filename: basename, lowercased, non-alnum -> `-`. */
  function roleFromFileName(name: string): string {
    const base = name.replace(/\.[^.]+$/, "");
    const slug = base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "file";
  }

  function uniqueRole(base: string): string {
    if (!allFileRoles.includes(base)) return base;
    let n = 2;
    while (allFileRoles.includes(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  /** Commit the typed-path flow: role + /absolute/path. Called via Enter in either field. */
  function commitFileRole() {
    const role = (pendingFileRole ?? "").trim();
    if (!role || allFileRoles.includes(role)) {
      cancelFileEdit();
      return;
    }
    setExtraFileRoles((prev) => [...prev, role]);
    if (pendingFilePath.trim()) {
      setFilePath(role, pendingFilePath.trim());
    }
    cancelFileEdit();
  }

  /** Upload flow: picking a file immediately commits with role = typed-or-derived. */
  async function commitFileUpload(file: File) {
    const typed = (pendingFileRole ?? "").trim();
    const role = typed || uniqueRole(roleFromFileName(file.name));
    if (allFileRoles.includes(role)) {
      cancelFileEdit();
      return;
    }
    setExtraFileRoles((prev) => [...prev, role]);
    await handleUpload(role, file);
    cancelFileEdit();
  }

  function cancelParamEdit() {
    setPendingParamKey(null);
    setPendingParamValue("");
  }

  function commitParamKey() {
    const key = (pendingParamKey ?? "").trim();
    if (!key || allParamKeys.includes(key)) {
      cancelParamEdit();
      return;
    }
    setExtraParamKeys((prev) => [...prev, key]);
    setParam(key, pendingParamValue);
    cancelParamEdit();
  }

  const fileRoleEditor =
    pendingFileRole !== null ? (
      <div className="flex items-center gap-2">
        <input
          autoFocus
          type="text"
          value={pendingFileRole}
          onChange={(e) => setPendingFileRole(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitFileRole();
            }
            if (e.key === "Escape") cancelFileEdit();
          }}
          placeholder="File role (e.g. recipe, prd)"
          className={cn(fieldClass, "w-28 flex-none")}
        />
        {!hosted && (
          <input
            type="text"
            value={pendingFilePath}
            onChange={(e) => setPendingFilePath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitFileRole();
              }
              if (e.key === "Escape") cancelFileEdit();
            }}
            placeholder="/absolute/path or click upload"
            className={fieldClass}
          />
        )}
        <label
          className={cn(
            "shrink-0 inline-flex items-center gap-1.5 justify-center h-9 px-3 rounded-md cursor-pointer",
            "bg-[var(--primary)] text-[var(--primary-fg,white)] text-[12px] font-medium",
            "hover:opacity-90 transition-opacity",
          )}
          title="Upload file (auto-adds entry)"
        >
          <Upload size={12} />
          Upload
          <input
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) commitFileUpload(f);
            }}
          />
        </label>
        <Button type="button" size="sm" variant="outline" onClick={cancelFileEdit}>
          Cancel
        </Button>
      </div>
    ) : (
      <Button type="button" size="sm" variant="outline" onClick={() => setPendingFileRole("")}>
        <Paperclip size={12} className="mr-1" /> Add file
      </Button>
    );

  const paramKeyEditor =
    pendingParamKey !== null ? (
      <div className="flex items-center gap-2">
        <input
          autoFocus
          type="text"
          value={pendingParamKey}
          onChange={(e) => setPendingParamKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitParamKey();
            }
            if (e.key === "Escape") cancelParamEdit();
          }}
          placeholder="Param name"
          className={cn(fieldClass, "w-28 flex-none")}
        />
        <input
          type="text"
          value={pendingParamValue}
          onChange={(e) => setPendingParamValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitParamKey();
            }
            if (e.key === "Escape") cancelParamEdit();
          }}
          placeholder="Value"
          className={fieldClass}
        />
        <Button type="button" size="sm" onClick={commitParamKey}>
          Add
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={cancelParamEdit}>
          Cancel
        </Button>
      </div>
    ) : (
      <Button type="button" size="sm" variant="outline" onClick={() => setPendingParamKey("")}>
        <Plus size={12} className="mr-1" /> Add param
      </Button>
    );

  return (
    <div className="mb-4 space-y-3" data-testid="inputs-section">
      <div>
        {allFileRoles.length > 0 && (
          <div className="text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Files
          </div>
        )}
        <div className="space-y-2">
          {allFileRoles.map((role) => {
            const def = schema?.files?.[role];
            const isExtra = !declaredFileRoles.includes(role);
            const currentLocator = value.files[role] ?? "";
            const hasFile = currentLocator.length > 0;
            return (
              <div key={role} className="flex items-center gap-2">
                <div className="w-28 flex items-center gap-1.5 text-[12px] text-[var(--fg)] truncate" title={role}>
                  {previews?.[role] && (
                    <img
                      src={previews[role]}
                      alt=""
                      className="h-6 w-6 rounded object-cover shrink-0 border border-[var(--border)]"
                    />
                  )}
                  <span className="truncate">
                    {role}
                    {def?.required ? <span className="text-[var(--failed)] ml-0.5">*</span> : null}
                  </span>
                </div>
                {hasFile || hosted ? (
                  <div className={cn(fieldClass, "flex items-center text-[var(--fg-muted)] truncate")}>
                    {hasFile ? (
                      <span className="truncate" title={currentLocator}>
                        {/* Local: show whatever the user has (typed path or locator). Hosted: basename-ish. */}
                        {hosted ? currentLocator.split("/").pop() || currentLocator : currentLocator}
                      </span>
                    ) : (
                      <span className="text-[var(--fg-faint)]">click Upload</span>
                    )}
                  </div>
                ) : (
                  <input
                    type="text"
                    value={currentLocator}
                    onChange={(e) => setFilePath(role, e.target.value)}
                    placeholder={def?.description ?? "/absolute/path or click upload"}
                    className={fieldClass}
                  />
                )}
                {!hasFile && (
                  <label
                    className={cn(
                      "shrink-0 inline-flex items-center justify-center h-9 px-3 rounded-md cursor-pointer",
                      "border border-[var(--border)] text-[12px] hover:border-[var(--fg-muted)] transition-colors",
                    )}
                    title="Upload file"
                  >
                    <Upload size={12} />
                    <input
                      type="file"
                      className="hidden"
                      accept={def?.accept}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleUpload(role, f);
                      }}
                    />
                  </label>
                )}
                {isExtra ? (
                  <button
                    type="button"
                    aria-label={`Remove ${role}`}
                    onClick={() => removeFile(role)}
                    className="shrink-0 h-9 w-9 inline-flex items-center justify-center rounded-md text-[var(--fg-muted)] hover:text-[var(--fg)]"
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <div className="w-9" />
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-2">{fileRoleEditor}</div>
      </div>

      <div>
        {allParamKeys.length > 0 && (
          <div className="text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Params
          </div>
        )}
        <div className="space-y-2">
          {allParamKeys.map((key) => {
            const def = schema?.params?.[key];
            const isExtra = !declaredParamKeys.includes(key);
            return (
              <div key={key} className="flex items-center gap-2">
                <div className="w-28 text-[12px] text-[var(--fg)] truncate" title={key}>
                  {key}
                  {def?.required ? <span className="text-[var(--failed)] ml-0.5">*</span> : null}
                </div>
                <input
                  type="text"
                  value={value.params[key] ?? ""}
                  onChange={(e) => setParam(key, e.target.value)}
                  placeholder={def?.description ?? "value"}
                  className={fieldClass}
                />
                {isExtra ? (
                  <button
                    type="button"
                    aria-label={`Remove ${key}`}
                    onClick={() => removeParam(key)}
                    className="shrink-0 h-9 w-9 inline-flex items-center justify-center rounded-md text-[var(--fg-muted)] hover:text-[var(--fg)]"
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <div className="w-9" />
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-2">{paramKeyEditor}</div>
      </div>
    </div>
  );
}
