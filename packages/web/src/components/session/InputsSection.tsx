/**
 * Flow-aware session inputs editor.
 *
 * Renders two editors driven by the selected flow's declarative `inputs:`
 * contract:
 *   - Files: role -> absolute path. Either upload (bytes -> server persists
 *     to arkDir/inputs/<id>/<name>, path returned) or type an inline path.
 *   - Params: k -> v. Declared params get labels + defaults + pattern hints;
 *     the user may add arbitrary extra k=v rows at dispatch time.
 *
 * The final shape is bubbled to the parent as:
 *   { files: Record<role, absPath>, params: Record<k, v> }
 *
 * Empty maps are fine -- callers should treat `undefined` as "no inputs".
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../../hooks/useApi.js";
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
}

const fieldClass = cn(
  "flex h-9 w-full rounded-md border border-[var(--border)] bg-transparent",
  "px-3 py-1 text-[13px] text-[var(--fg)] transition-colors",
  "placeholder:text-[var(--fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]",
);

export function InputsSection({ flowName, value, onChange, onValidityChange }: Props) {
  const [schema, setSchema] = useState<FlowInputsSchema | null>(null);

  // Ad-hoc extras: roles/keys the user added that are not in the flow schema.
  // Kept separately so we can render their rows with remove buttons.
  const [extraFileRoles, setExtraFileRoles] = useState<string[]>([]);
  const [extraParamKeys, setExtraParamKeys] = useState<string[]>([]);

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

  const allFileRoles = useMemo(
    () => [...declaredFileRoles, ...extraFileRoles.filter((r) => !declaredFileRoles.includes(r))],
    [declaredFileRoles, extraFileRoles],
  );
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
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    // Chunked base64 to avoid call-stack issues on large files.
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    }
    const content = btoa(bin);
    const { path } = await api.uploadInput({ name: file.name, role, content, contentEncoding: "base64" });
    onChange({ ...value, files: { ...value.files, [role]: path } });
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
  }

  function removeParam(key: string) {
    const { [key]: _omit, ...rest } = value.params;
    onChange({ ...value, params: rest });
    setExtraParamKeys((prev) => prev.filter((k) => k !== key));
  }

  function addExtraFileRole() {
    const role = window.prompt("File role (e.g. recipe, prd):")?.trim();
    if (!role) return;
    if (allFileRoles.includes(role)) return;
    setExtraFileRoles((prev) => [...prev, role]);
  }

  function addExtraParamKey() {
    const key = window.prompt("Param name:")?.trim();
    if (!key) return;
    if (allParamKeys.includes(key)) return;
    setExtraParamKeys((prev) => [...prev, key]);
    setParam(key, "");
  }

  if (allFileRoles.length === 0 && allParamKeys.length === 0 && !schema) {
    // No declared schema and no extras yet -- render a single disclosure button.
    return (
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={addExtraFileRole}>
            <Paperclip size={12} className="mr-1" /> Add file
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={addExtraParamKey}>
            <Plus size={12} className="mr-1" /> Add param
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 space-y-3" data-testid="inputs-section">
      {allFileRoles.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Files
          </div>
          <div className="space-y-2">
            {allFileRoles.map((role) => {
              const def = schema?.files?.[role];
              const isExtra = !declaredFileRoles.includes(role);
              return (
                <div key={role} className="flex items-center gap-2">
                  <div className="w-28 text-[12px] text-[var(--fg)] truncate" title={role}>
                    {role}
                    {def?.required ? <span className="text-[var(--failed)] ml-0.5">*</span> : null}
                  </div>
                  <input
                    type="text"
                    value={value.files[role] ?? ""}
                    onChange={(e) => setFilePath(role, e.target.value)}
                    placeholder={def?.description ?? "/absolute/path or click upload"}
                    className={fieldClass}
                  />
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
          <div className="mt-2">
            <Button type="button" size="sm" variant="outline" onClick={addExtraFileRole}>
              <Paperclip size={12} className="mr-1" /> Add file
            </Button>
          </div>
        </div>
      )}

      {allParamKeys.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Params
          </div>
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
          <div className="mt-2">
            <Button type="button" size="sm" variant="outline" onClick={addExtraParamKey}>
              <Plus size={12} className="mr-1" /> Add param
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
