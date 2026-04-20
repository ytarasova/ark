/**
 * Local-mode file input row.
 *
 * When no file is yet set, the user may type an absolute path directly into
 * the row or click Upload. When a file is set, the full locator/path is shown
 * verbatim (it's useful to see the whole thing on a local-dev box).
 */

import { cn } from "../../lib/utils.js";
import { FileInputRowShell, fieldClass } from "./file-input-row-shell.js";
import type { FileInputRowProps } from "./binding-types.js";

export function LocalFileInputRow(props: FileInputRowProps) {
  const { role, required, description, accept, value, isExtra, previewUrl, onTypeValue, onUpload, onRemove } = props;
  const hasFile = value.length > 0;

  return (
    <FileInputRowShell
      role={role}
      required={required}
      accept={accept}
      previewUrl={previewUrl}
      isExtra={isExtra}
      hasFile={hasFile}
      onUpload={onUpload}
      onRemove={onRemove}
      emptySlot={
        <input
          type="text"
          value={value}
          onChange={(e) => onTypeValue(e.target.value)}
          placeholder={description ?? "/absolute/path or click upload"}
          className={fieldClass}
        />
      }
      filledSlot={
        <div className={cn(fieldClass, "flex items-center text-[var(--fg-muted)] truncate")}>
          <span className="truncate" title={value}>
            {value}
          </span>
        </div>
      }
    />
  );
}
